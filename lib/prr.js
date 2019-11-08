#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * This walks through the given github pull request, collecting ticket/synopses
 * and calls the GitHub squash/merge PUT API with a commit message that
 * has "Reviewed by:" and "Approved by:" lines generated from the reviewers
 * of the pull request.
 *
 * It writes a commit message computed from the given pull request to a
 * temporary file, fires up $EDITOR, asks "is this commit message ok"
 * (in a loop till you say 'y') and then does merge+squash of the PR.
 *
 * In future we might also choose to cross-check that the supplied Github
 * ticket synopsis matches the actual Jira synopsis, modulo '(fix build)' etc.
 * commits.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var child_process = require('child_process');
var dashdash = require('dashdash');
var format = require('util').format;
var fs = require('fs');
var mod_vasync = require('vasync');
var parseGitConfig = require('parse-git-config');
var prompt = require('prompt');
var restifyClients = require('restify-clients');
// .track() causes the tempfile to be deleted once we exit
var temp = require('temp').track();
var VError = require('verror');

var log = bunyan.createLogger({
    name: 'prr',
    serializers: bunyan.stdSerializers,
    stream: process.stdout
});

if (process.env.TRACE && process.env.TRACE !== '0') {
    log.level(bunyan.TRACE);
}

var gitClient = restifyClients.createJsonClient({
    log: log,
    url: 'https://api.github.com'
});

var submitter = null;
var prNumber = null;

// match JIRA-format ticket names, expected at the beginning of the line
var TICKET_RE = new RegExp('^[A-Z]+-[0-9]+ ');

// Some joyent users don't have email addresses in their github profiles.
// Fallback to this list instead. This gets loaded from ~/.prrconfig
var USER_EMAIL = {};

var PRR_CONFIG;
var PRR_CONFIG_PATH = expandTilde('~/.prrconfig');
if (fs.existsSync(PRR_CONFIG_PATH)) {
    try {
        PRR_CONFIG = JSON.parse(fs.readFileSync(PRR_CONFIG_PATH, 'utf8'));
        if (PRR_CONFIG.userEmail !== undefined) {
            USER_EMAIL = PRR_CONFIG.userEmail;
        }
    } catch (e) {
        console.log('Unable to parse json ~/.prrconfig: ' + e);
        process.exit(1);
    }
}

/*
 * Rudimentary ~ directory expansion. This doesn't work for user-relative paths
 * such as "~timf/foo"
 */
function expandTilde(path) {
    if (path.indexOf('~/') === 0) {
        if (process.env.HOME !== undefined) {
            return path.replace('~/', process.env.HOME + '/');
        }
    }
    // give up.
    return path;
}

/*
 * Compute the "gituser/gitrepo" string from the repository pointed to by
 * process.env.GITREPO value or process.env.PWD XXX add better feedback when
 * falling back to $PWD
 *
 * @param {Function} cb - `function (err, standard gitHub "owner/repo" string)`
 */
function determineGitRepo(args, cb) {
    assert.func(cb, 'cb');
    assert.optionalString(args.repoPath, 'args.repoPath');
    var repoPath;
    if (args.repoPath) {
        repoPath = args.repoPath;
    } else {
        repoPath = process.env.GITREPO;
    }
    if (!repoPath) {
        repoPath = process.env.PWD;
    }

    var cfgPath = expandTilde(repoPath + '/.git/config');
    fs.exists(cfgPath, function(exists) {
        if (!exists) {
            cb(new VError(format('%s does not exist. ' +
                '$GITREPO or $PWD should point to a git repository', cfgPath)));
        }
        var gitConfig = parseGitConfig.sync({'path': cfgPath});
        if (gitConfig['remote "origin"'] === undefined) {
            cb(new VError('unable to determine git origin for ' + cfgPath));
        }
        var url = gitConfig['remote "origin"'].url;
        var gitUser = '';
        var gitRepoName = '';

        if (url.indexOf('http') !== 0 && url.indexOf('@') !== 0) {
            var repoPair = url.split(':')[1].split('/');
            gitUser = repoPair[0];
            gitRepoName = repoPair[1];
        } else {
            var urlElements = url.split('/');
            gitUser = urlElements[urlElements.length - 2];
            gitRepoName = urlElements[urlElements.length - 1];
        }
        if (gitRepoName.endsWith('.git')) {
            gitRepoName= gitRepoName.substr(0, gitRepoName.length - 4);
        }
        cb(null, format('%s/%s', gitUser, gitRepoName));
    });
}

/*
 * Get github credentials either from ~/.gitconfig e.g.
 * [squashmerge]
 *     githubUser = timfoster
 *     githubApiTokenFile = ~/.github_api_token_file
 *
 * Or via $GITHUB_USER and $GITHUB_API_TOKEN_FILE environment variables.
 * If we can't find a token file, fall back to '~/.github-api-token'.
 * With this information, initialize our restifyClient. Invokes cb with an
 * error object if we weren't able to initialize the client for any reason
 * or were missing other credentials.
 *
 * @param {Function} cb - `function (err)`
 */
function initializeGitClient(cb) {
    assert.func(cb, 'cb');

    // Get GitHub login credentials, and initialize our restifyClient
    var gitHubUser = process.env.GITHUB_USER;
    if (gitHubUser === undefined) {
        if (PRR_CONFIG['gitHubUser'] !== undefined) {
            gitHubUser = PRR_CONFIG['gitHubUser'];
        }
        if (gitHubUser === undefined) {
            cb(new VError('unable to determine username from ~/.prrconfig' +
                'or $GITHUB_USER'));
            return;
        }
    }
    var tokenFile = process.env.GITHUB_API_TOKEN_FILE;
    if (process.env.GITHUB_API_TOKEN_FILE === undefined) {
        if (PRR_CONFIG['gitHubApiTokenFile'] !== undefined) {
            tokenFile = PRR_CONFIG['gitHubApiTokenFile'];
        }
    }
    if (tokenFile === undefined) {
        tokenFile = '~/.github-api-token';
    }
    tokenFile = expandTilde(tokenFile);
    fs.readFile(tokenFile, 'utf8', function(err, data) {
        if (err) {
            cb(new VError('failed to read %s: %s', tokenFile, err));
            return;
        }
        var gitHubAPIToken = data.trim();
        gitClient.basicAuth(gitHubUser, gitHubAPIToken);
        cb(null);
    });
}

/*
 * Get miscellaneous properties from this PR.
 *
 * @param {String} args.gitRepo - The github "username/repo" string.
 * @param {String} args.tickets - any existing ticket information we have.
 * @param {String} args.prNumber - the number of the beast^Wcommit message
 * @param {Function} cb - `function (err, submitter, title, ticketInfo, state)`
 */
function gatherPullRequestProps(args, cb) {
    assert.object(args, 'args');
    assert.string(args.gitRepo, 'args.gitRepo');
    assert.string(args.prNumber, 'args.prNumber');
    assert.func(cb, 'cb');

    var pullUrl = format('/repos/%s/pulls/%s', args.gitRepo, args.prNumber);
    gitClient.get(pullUrl,
        function getPr(err, req, res, pr) {
            var tickets = {};
            if (err !== null) {
                cb(err);
                return;
            }
            var submitter = pr.user.login;
            var title = pr.title.trim();
            var state = pr.state;
            if (TICKET_RE.test(title)) {
                tickets[(title.split(' ')[0])] = pr.title;
            }
            cb(null, submitter, title, tickets, state);
        }
    );
}

/*
 * Gathers commit messages from the commits pushed as part of this PR,
 * the SHA hash of the most recent commit in this PR (needed when merging the
 * PR), an object containing data about the tickets included in this pull
 * request, and an array of strings representing the commit messages for all
 * commits in this PR.
 *
 * @param {String} args.gitRepo - The github "username/repo" string.
 * @param {String} args.tickets - any existing ticket information we have.
 * @param {String} args.prNumber - the number of the beast^Wcommit message
 * @param {Function} cb - `function (err, lastCommit, ticketInfo, messages)`
 */
function gatherPullRequestCommits(args, cb) {
    assert.object(args, 'args');
    assert.object(args.tickets, 'args.tickets');
    assert.string(args.prNumber, 'args.prNumber');
    assert.string(args.gitRepo, 'args.gitRepo');

    assert.func(cb, 'cb');
    gitClient.get(format(
        '/repos/%s/pulls/%s/commits', args.gitRepo, args.prNumber),
        function getPr(err, req, res, commits) {
            if (err !== null) {
                cb(err);
                return;
            }
            var tickets = args.tickets;
            var messages = [];
            var lastCommit;
            commits.forEach(function processCommit(obj, index) {
                var lines = obj.commit.message.split('\n');
                lastCommit = obj.sha;
                lines.forEach(function extractTickets(line) {
                    if (TICKET_RE.test(line)) {
                        // record the jira ticket and full line
                        tickets[line.split(' ')[0]] = line.trim();
                        messages.push(line.trim());
                    } else {
                        messages.push(line.trim());
                    }
                });
            });
            cb(null, lastCommit, tickets, messages);
        }
    );
}

/*
 * Walk through the reviews in this PR to obtain an array of GitHub usernames
 * that reviewed the PR.
 *
 * @param {String} args.gitRepo - The github "username/repo" string.
 * @param {String} args.submitter - The username of the submitter
 * @param {String} args.prNumber - the number of the beast^Wcommit message
 * @param {Function} cb - `function (err, reviewers)`
 */
function gatherReviewerUsernames(args, cb) {
    assert.object(args, 'args');
    assert.string(args.gitRepo, 'args.gitRepo');
    assert.string(args.submitter, 'args.submitter');
    assert.string(args.prNumber, 'args.prNumber');
    assert.func(cb, 'cb');

    gitClient.get(
        format('/repos/%s/pulls/%s/reviews', args.gitRepo, args.prNumber),
        function getReviews(err, req, res, reviews) {
            if (err !== null) {
                cb(err);
                return;
            }
            // we don't have a format Set object, so make do with this
            var reviewers = {};
            reviews.forEach(function processReview(obj, index) {
                if (obj.user.login !== submitter) {
                    reviewers[obj.user.login] = true;
                }
            });
            cb(null, Object.keys(reviewers));
        }
    );
}

/*
 * Walk through the issue events stream for this PR, looking for label changes
 * that modify the 'integration-approval' label, recording the last username
 * that added the label. This is not required by all repositories.
 *
 * @param {String} args.gitrepo - The github "username/repo" string.
 * @param {String} args.prNumber - the number of the beast^Wcommit message
 * @param {Function} cb - `function (err, approvers)`
 */
function gatherApproverUsername(args, cb) {
    assert.object(args, 'args');
    assert.string(args.gitRepo, 'args.gitRepo');
    assert.string(args.prNumber, 'args.prNumber');
    assert.func(cb, 'cb');

    gitClient.get(
        format('/repos/%s/issues/%s/events', args.gitRepo, args.prNumber),
        function getEvents(err, req, res, events) {
            if (err !== null) {
                cb(err);
                return;
            }
            // Given the way the GitHub events API works, there should only ever
            // be a single user associated with a label. Here, if userA
            // grants approval and userB revokes it, we record no approver.
            var approver = null;
            events.forEach(function processEvent(obj, index) {
                if (obj.actor.login === submitter) {
                    return;
                }
                if (obj.event === 'labeled' &&
                        obj.label.name === 'integration-approval') {
                    approver = obj.actor.login;
                } else if (obj.event === 'unlabeled' &&
                        obj.label.name === 'integration-approval') {
                    approver = null;
                }
            });
            cb(null, approver);
        }
    );
}

/*
 * Given a list of usernames, return an object mapping each username
 * to a string in one of the formats:
 *
 * [First] [Last] <[email address]>
 * [First] [Last]
 * [username] <email address>
 * [username]
 *
 * We enforce a restriction that the user cannot be the same as the PR
 * submitter.
 *
 * @param {String} users - An array of reviewer username strings
 * @param {Function} cb - `function (err, reviewerNames)`
 */
function gatherUserContacts(args, users, cb) {
    assert.object(args, 'args');
    assert.arrayOfString(users, 'users');
    assert.func(cb, 'cb');

    var userContacts = {};
    mod_vasync.forEachParallel({
        inputs: users,
        func: function handleOneLogin(login, nextLogin) {
            emailContactFromUsername({user: login}, function (err, contact) {
                if (err) {
                    nextLogin(err);
                } else {
                    userContacts[login] = contact;
                    nextLogin();
                }
            });
        }
    }, function doneAllLogins(err) {
        cb(err, userContacts);
    });
}

/*
 * Get an email contact, e.g. "John Doe <john@example.com>", from
 * a GitHub username. Fall back to just the username, or the username
 * with no email address.
 *
 * @param {String} args.user - The github username.
 * @param {Function} cb - `function (err, contact)`
 */
function emailContactFromUsername(args, cb) {
    assert.object(args, 'args');
    assert.string(args.user, 'args.user');

    var user = args.user;

    gitClient.get('/users/' + user,
        function getUser(err, req, res, userInfo) {
            if (err) {
                cb(err);
                return;
            }
            var contact = userInfo.name || user;
            if (USER_EMAIL[user]) {
                contact += ' <' + USER_EMAIL[user] + '>';
            } else if (userInfo.email) {
                contact += ' <' + userInfo.email + '>';
            }
            cb(null, contact);
        });
}


// XXX we might want to pull ticket info directly from Jira to validate that
// the synopsis is correct. This might allow us to write a specific message
function gatherTicketInfo(cb) {
    ;
}

/*
 * Create and write to a temporary file containing the commit title and
 * commit message to be used when merging this pull request.
 *
 * @param {String} args.title - The title of this pull request
 * @param {String} args.reviewerContacts - a map of reviewers to their
 *                                         names/email addresses
 * @param {Array} args.messages - A list of strings containing the commit
 *                                messages for this review.
 * @param {Function} cb - `function (err, commit message file path)`
 */
function writeCommitMessage(args, cb) {
    assert.object(args, 'args');
    assert.string(args.title, 'args.title');
    assert.object(args.reviewerContacts, 'args.reviewerContacts');
    assert.optionalString(args.approverContact, args.approverContact);
    assert.arrayOfString(args.messages, 'args.messages');
    assert.func(cb, 'cb');

    temp.open({suffix: '.txt'}, function(err, info) {
        if (err) {
            cb(err);
            return;
        }

        // Often, PR titles are the same as the first commit message line in
        // the PR. Try to catch these cases by only emitting the title text
        // if it's different to the first commit message line.
        if (args.messages.length > 0) {
            if (args.title !== args.messages[0]) {
               fs.writeSync(info.fd, args.title + '\n\n');
               fs.writeSync(info.fd, args.messages.join('\n') + '\n');
            } else {
                fs.writeSync(info.fd, args.title + '\n\n');
                fs.writeSync(info.fd, args.messages.slice(1).join('\n') + '\n');
            }
        } else {
            // no messages, so just use the title. This should be impossible.
            fs.writeSync(info.fd, args.title + '\n\n');
        }
        Object.keys(args.reviewerContacts).sort().forEach(
            function(reviewer, index) {
                fs.writeSync(info.fd, format(
                    'Reviewed by: %s\n', args.reviewerContacts[reviewer]));
            });
        if (args.approverContact) {
            fs.writeSync(info.fd, format(
                    'Approved by: %s\n', args.approverContact));
        }
        fs.close(info.fd, function(err) {
          if (err) {
              cb(err);
              return;
          }
          cb(null, info.path);
        });
    });
}

/*
 * Invoke $EDITOR or `vi` on the commit message synchronously.
 *
 * @param {String} args.commitMessagePath - The file path to edit
 * @param {Function} cb - `function (err, exit status)`
 */
function editCommitMessage(arg, cb) {
    assert.object(arg, 'arg');
    assert.string(arg.commitMessagePath, 'arg.commitMessagePath');
    assert.func(cb, 'cb');
    var editor = process.env.EDITOR || 'vi';
    // modify the commit message
    var child = child_process.spawnSync(editor, [arg.commitMessagePath], {
        stdio: 'inherit'
    });
    cb(null, child.status);
}

/*
 * Read the supplied commit message file and make it available as a string.
 * We try to format the message in standard Git form:
 * '''
 * <first line of message>
 *
 * <subsequent lines of commit message>
 * '''
 *
 * We invoke a callback to provide access to the first line of the commit
 * message (usually the title of the PR) followed by the remaining lines.
 *
 * @param {String} args.commitMessagePath - The file path to read
 * @param {Function} cb - `function (err, first line of message,
 *                                   remainder of commit message)`
 */
function readCommitMessage(args, cb) {
    assert.object(args, 'args');
    assert.string(args.commitMessagePath, 'args.commitMessagePath');
    assert.func(cb, 'cb');
    fs.readFile(args.commitMessagePath, function(err, data) {
        if (err) {
            cb(err);
            return;
        }
        var fullMessage = data.toString();
        var lines = fullMessage.split('\n');
        var title = lines[0];
        var msg_lines = [];
        if (lines.length > 1) {
            for (var i = 1; i < lines.length; i++) {
                // skip the first blank line since that's the separator between
                // the github title, and subsequent commit message body.
                if (i === 1 && lines[i] === '') {
                        continue;
                }
                msg_lines.push(lines[i]);
            }
        }
        cb (err, title, msg_lines.join('\n'));
    });
}

/*
 * Display a commit message to the user, and ask them if it's acceptable.
 * Our callback provides access to the answer to the question.
 *
 * @param {String} args.commitMessagePath - The file path to edit
 * @param {Function} cb - `function (err, user answer y/n)`
 */
function yesNoPrompt(args, cb) {
    assert.object(args, 'args');
    assert.string(args.commitMessage, 'args.commitMessage');
    assert.func(cb, 'cb');

    console.log('Commit message is:');
    console.log('---------');

    console.log(args.title);
    if (args.commitMessage) {
        // there may be a trailing newline on the commit message which
        // GitHub ignores, but try not to alarm the user.
        var emit = args.commitMessage;
        if (emit[emit.length - 1] === '\n') {
            emit = emit.slice(0, emit.length - 1);
        }
        console.log(emit);
    }
    console.log('--------');
    if (Object.keys(args.tickets).length > 0) {
        console.log(
            format(
                'This commit contains the following tickets: %s',
                Object.keys(args.tickets).join(', ')));
    }

    var user_question = 'Is this commit message ok? (y/n, Ctrl-C to abort) ';
    var prompt_schema = {
        properties: {
            answer: {
                description: user_question,
                pattern: /^[yn]$/,
                message: 'y or n will do!',
                required: true
            }
        }
    };
    prompt.colors = false;
    prompt.message = '';
    prompt.start();
    prompt.get(
        prompt_schema,
        function user_input(prompt_err, result) {
            if (prompt_err) {
                cb(new VError(
                    prompt_err,
                    'problem trying to prompt user'));
                return;
            }
            cb(null, result.answer);
    });
}

/*
 * In a loop, invoke an editor on the given commit message file, read the file
 * into a variable, and ask the user if it's acceptable. Stop as soon as they
 * say 'y'.
 * Calls a callback providing access to the PR title and commit message,
 * see readCommitMessage(..)
 *
 * @param {String} args.commitMessagePath - The file path to edit
 * @param {Function} cb - `function (err, PR title, commitMessage)`
 */
function decideCommitMessage(arg, cb) {

    arg['commitMessageAccepted'] = false;
    mod_vasync.whilst(
        function guard() {
            if (!context.commitMessageAccepted) {
                log.debug('commit message has not yet been accepted');
                return true;
            }
            log.debug('commit message has been accepted');
            return false;
        },
        function loop(nextLoop) {
            mod_vasync.pipeline({
                arg: arg,
                funcs: [
                function modifyCommitMessage(arg, nextStage) {
                    editCommitMessage(arg,
                        function editedCommitMessage(err) {
                            if (err) {
                                nextStage(err);
                                return;
                            }
                            nextStage();
                        });
                },
                function getCommitMessage(arg, nextStage) {
                    readCommitMessage(arg,
                        function collectCommitMessage(err, title, msg) {
                            if (err) {
                                nextStage(err);
                                return;
                            }
                            arg.title = title;
                            arg.commitMessage = msg;
                            nextStage();
                        });
                },
                function getYesNo(arg, nextStage) {
                    yesNoPrompt(arg,
                        function collectAnswer(err, answer) {
                            if (err) {
                                nextStage(err);
                                return;
                            }
                            if (answer === 'y') {
                                arg.commitMessageAccepted = true;
                            }
                            nextStage();
                        });
                }
            ]},
            function pipelineResults(err, results) {
                if (err) {
                    nextLoop(new VError(
                        format('problem editing commit message: %s',
                            err.message)), null);
                    return;
                }
                nextLoop(null, context);
            });
        },
        function (err, result) {
            if (err) {
                cb(err);
                return;
            }
            cb(null, arg.title, arg.commitMessage);
        });
}

/*
 * Invoke the GitHub merge API to merge a pull request using the 'squash'
 * merge method.
 *
 * @param {String} args.lastCommit - The SHA of the last commit in this PR
 * @param {String} args.title - The PR title
 * @param {String} args.commitMessage - The formatted commit message for this PR
 *                                      which does *not* include the title
 * @param {String} args.prNumber - the number of the beast^Wcommit message
 * @param {String} args.gitRepo - The GitHub "user/repo" string
 * @param {Function} cb - `function (err, obj result from GitHub)`
 */
function squashMerge(args, cb) {
    assert.object(args, 'args');
    assert.string(args.title, 'args.title');
    assert.string(args.lastCommit, 'args.lastCommit');
    assert.string(args.commitMessage, 'args.commitMessage');
    assert.string(args.gitRepo, 'args.gitRepo');
    assert.string(args.prNumber, 'args.prNumber');
    assert.func(cb, 'cb');
    log.debug({
        'merge_method': 'squash',
        'sha': args.lastCommit,
        'commit_title': args.title,
        'commit_message': args.commitMessage
    });

    gitClient.put(
        format('/repos/%s/pulls/%s/merge', args.gitRepo, args.prNumber),
        {
            'merge_method': 'squash',
            'sha': args.lastCommit,
            'commit_title': args.title,
            'commit_message': args.commitMessage
        },
        function putResp(err, req, res, obj) {
            if (err) {
                cb(err);
                return;
            }
            log.debug(obj);
            cb(null, obj);
        }
    );
}

function usage() {
    console.log('Usage: prr [-C GITREPO] [-v] <pull request number>');
    process.exit(2);
}

// main

// Specify the options. Minimally `name` (or `names`) and `type`
// must be given for each.
var cli_options = [
    {
        // `names` or a single `name`. First element is the `opts.KEY`.
        names: ['help', 'h'],
        // See "Option specs" below for types.
        type: 'bool',
        help: 'Print this help and exit.'
    },
    {
        names: ['gitrepo', 'C'],
        type: 'string',
        help: 'A path to the local git repository to act upon.'
    },
    {
        names: ['verbose', 'v'],
        type: 'arrayOfBool',
        help: 'Verbose output. Use multiple times for more verbose.'
    },
];

var context = {};
var parser = dashdash.createParser({options: cli_options});
try {
    var opts = parser.parse(process.argv);

    if (opts.verbose) {
        log.level(bunyan.DEBUG);
    }
    if (opts.help) {
        usage();
    }
    if (PRR_CONFIG === undefined) {
        console.log('Error: no ~/.prrconfig file found')
        process.exit(1);
    }
    if (opts._args.length !== 1) {
        console.log('Error: missing pr number');
        usage();
    }
    if (opts.gitrepo) {
        context.repoPath = expandTilde(opts.gitrepo);
    }
    context.prNumber = opts._args[0];
} catch (e) {
    console.error('prr: error: %s', e.message);
    process.exit(1);
}

// Use `parser.help()` for formatted options help.
if (opts.help) {
    var help = parser.help({includeEnv: true}).trimRight();
    console.log('usage: node foo.js [OPTIONS]\n'
                + 'options:\n'
                + help);
    process.exit(0);
}

mod_vasync.pipeline({
    arg: context,
    funcs: [
        function getGitInfo(arg, next) {
            determineGitRepo(arg, function collectGitRepo(err, gitRepo) {
                if (err) {
                    next(err);
                    return;
                }
                arg.gitRepo = gitRepo;
                next();
            });
        },
        function emitMessage(arg, next) {
            console.log(
                format('Gathering commit information for %s#%s',
                    arg.gitRepo, arg.prNumber));
            next();
        },
        function setupClient(arg, next) {
            initializeGitClient(next);
        },
        function getPrProps(arg, next) {
            gatherPullRequestProps(arg,
                function collectProps(err, submitter, title, tickets, state) {
                    if (err) {
                        console.log(
                            format('Unable to gather pull request properties ' +
                                'for %s#%s', arg.gitRepo, arg.prNumber));
                        next(err);
                        return;
                    }
                    if (state !== 'open') {
                        next(new VError(
                            format('Cannot merge a PR that is in state \'%s\'',
                                state)));
                        return;
                    }
                    arg.submitter = submitter;
                    arg.title = title;
                    arg.tickets = tickets;
                    next();
                });
        },
        function getPrCommits(arg, next) {
            gatherPullRequestCommits(arg,
                function collectPRCommits(err, lastCommit, tickets, msgs){
                    if (err) {
                        console.log(
                            format('Unable to gather commits for %s#%s',
                                arg.gitRepo, arg.prNumber));
                        next(err);
                        return;
                    }
                    log.debug('tickets are ' + JSON.stringify(tickets));
                    arg.tickets = tickets;
                    arg.lastCommit = lastCommit;
                    arg.messages = msgs;
                    next();
            });
        },
        function getReviewerUsernames(arg, next) {
            gatherReviewerUsernames(arg,
                function collectPRReviewers(err, reviewers){
                    if (err) {
                        console.log(
                            format('Unable to get reviewer usernames for ' +
                                '%s#%s', arg.gitRepo, arg.prNumber));
                        next(err);
                        return;
                    }
                    arg.reviewers = reviewers;
                    next();
                });
        },
        function getReviewerContacts(arg, next) {
            gatherUserContacts(arg, arg.reviewers,
                function collectReviewerContacts(err, reviewerContacts) {
                    if (err) {
                        console.log(
                            format('Unable to get reviewer details for ' +
                                '%s#%s', arg.gitRepo, arg.prNumber));
                        next(err);
                        return;
                    }
                    arg.reviewerContacts = reviewerContacts;
                    next();
                });
        },
        function getApproverUsernames(arg, next) {
            arg.approver = null;
            gatherApproverUsername(arg,
                function collectPRApprovers(err, approver) {
                    if (err) {
                        console.log(
                            format('Unable to get approver usernames for ' +
                                '%s#%s', arg.gitRepo, arg.prNumber));
                        next(err);
                        return;
                    }
                    arg.approver = approver;
                    next();
                });
        },
        function getApproverContacts(arg, next) {
            arg.approverContact = null;
            if (arg.approver === null) {
                next();
                return;
            }
            // gatherUserContacts expects and returns an array, but we only
            // ever have a single approver, so deal with that.
            gatherUserContacts(arg, [arg.approver],
                function collectApproverContacts(err, approverContacts) {
                    if (err) {
                        console.log(
                            format('Unable to get approver details for ' +
                                '%s#%s', arg.gitRepo, arg.prNumber));
                        next(err);
                        return;
                    }
                    if (approverContacts) {
                        arg.approverContact = approverContacts[
                            Object.keys(approverContacts)[0]];
                    }
                    next();
                });
        },
        function getSubmitterContact(arg, next) {
            emailContactFromUsername({user: arg.submitter},
                function collectSubmitter(err, submitterContact) {
                    if (err) {
                        console.log(
                            format('Unable to get submitter details for ' +
                                '%s#%s', arg.gitRepo, arg.prNumber));
                        next(err);
                        return;
                    }
                    arg.submitterContact = submitterContact;
                    next();
                });
        },
        function getCommitMessage(arg, nextStage) {
            writeCommitMessage(arg,
                function collectCommitMessagePath(err, path) {
                    if (err) {
                        console.log(
                            format('Unable to write commit message path for ' +
                                '%s#%s', arg.gitRepo, arg.prNumber));
                        nextStage(err);
                        return;
                    }
                    arg.commitMessagePath = path;
                    log.debug('commit message is at ' + path);
                    nextStage();
                });
        },
        function validateCommitMessage(arg, next) {
            decideCommitMessage(arg,
                function gatherCommitMessage(err, title, msg) {
                    if (err) {
                        console.log(
                            format('Unable to edit commit message for ' +
                                '%s#%s', arg.gitRepo, arg.prNumber));
                        next(err);
                        return;
                    }
                    arg.title = title;
                    arg.commitMessage = msg;
                    next();
                });
        },
        function squashAndMerge(arg, next) {
            squashMerge(arg, function collectResult(err, result) {
                if (err) {
                    next(err);
                    return;
                }
                if (result.merged) {
                    console.log(result.message);
                    next();
                    return;
                } else {
                    next(
                        new VError(
                            format('this pr was not merged: %s', result.message)
                        ));
                }
            });
        }
    ]
}, function (err, results) {
        if (err) {
            console.log(format('Error: %s', err.message));
        }
       log.debug(JSON.stringify(results));
});