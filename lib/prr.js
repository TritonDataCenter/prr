#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
<<<<<<< HEAD
 * Copyright 2020 Joyent, Inc.
 * Copyright 2022 MNX Cloud, Inc.
=======
 * Copyright 2019 Joyent, Inc.
 * Copyright 2023 MNX Cloud, Inc.
>>>>>>> f852430 (Get make check to pass before rebase with master)
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

const assert = require('assert-plus');
const bunyan = require('bunyan');
const child_process = require('child_process');
const dashdash = require('dashdash');
const format = require('util').format;
const fs = require('fs');
const mod_vasync = require('vasync');
const parseGitConfig = require('parse-git-config');
const prompt = require('prompt');
const restifyClients = require('restify-clients');
// .track() causes the tempfile to be deleted once we exit
var temp = require('temp').track();
var VError = require('verror');
var yaml = require('yaml');

/*
 * Polyfill for older node versions.
 */
Object.values = Object.values || function(o) {
	return (Object.keys(o).map(function (k) { return (o[k]); }));
};

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
    url: 'https://api.github.com',
    followRedirects: true
});

// match JIRA format ticket names, for example, 'FOO-123 '
var TICKET_RE = new RegExp('^[A-Z]+-[0-9]+ ');
// match GitHub format ticket names, for example 'owner/repo#1234 '
// we allow alphanumeric chars, hyphens and underscores
var GITHUB_TICKET_RE = new RegExp('^[a-zA-Z0-9-_]+/[a-zA-Z0-9-_]+#[0-9]+ ');

// Some joyent users don't have email addresses in their github profiles.
// Fallback to this list instead. This gets loaded from ~/.prrconfig
var USER_EMAIL = {};

var PRR_CONFIG = {};
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

var HUB_CONFIG_PATH = expandTilde('~/.config/hub');

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
            cb(
                new VError(
                    format(
                        '%s does not exist. $GITREPO or $PWD should point to ' +
                            'a git repository',
                        cfgPath
                    )
                )
            );
            return;
        }
        var gitConfig = parseGitConfig.sync({ path: cfgPath });
        if (gitConfig['remote "origin"'] === undefined) {
            cb(new VError('unable to determine git origin for ' + cfgPath));
            return;
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
            gitRepoName = gitRepoName.substr(0, gitRepoName.length - 4);
        }

        cb(null, format('%s/%s', gitUser, gitRepoName));
    });
}

/*
 * Get github credentials either from ~/.prrconfig, from hub(1)'s config, or via
 * $GITHUB_USER and $GITHUB_API_TOKEN_FILE environment variables.  If we can't
 * find a token file, fall back to '~/.github-api-token'.  With this
 * information, initialize our restifyClient. Invokes cb with an error object if
 * we weren't able to initialize the client for any reason or were missing other
 * credentials.
 *
 * @param {Function} cb - `function (err)`
 */
function initializeGitClient(cb) {
    assert.func(cb, 'cb');

    var gitHubUser = process.env.GITHUB_USER;
    var gitHubAPITokenFile = process.env.GITHUB_API_TOKEN_FILE;
    var gitHubAPIToken;
    var hubconfig;

    // Get GitHub login credentials, and initialize our restifyClient

    if (gitHubUser === undefined) {
        gitHubUser = PRR_CONFIG['gitHubUser'];
    }

    try {
        hubconfig = yaml.parse(fs.readFileSync(HUB_CONFIG_PATH, 'utf8'));
        if (gitHubUser === undefined) {
            gitHubUser = hubconfig['github.com'][0].user;
        }

        hubconfig['github.com'].forEach(function(item) {
            if (item.user === gitHubUser && gitHubAPITokenFile === undefined) {
                gitHubAPIToken = item.oauth_token;
                gitHubAPITokenFile = 'already-read';
            }
        });
    } catch (e) { // eslint-disable-line
    }

    if (gitHubUser === undefined) {
        cb(new VError('unable to determine github username'));
        return;
    }

    if (gitHubAPIToken !== undefined) {
        gitClient.basicAuth(gitHubUser, gitHubAPIToken);
        cb(null);
        return;
    }

    if (process.env.GITHUB_TOKEN !== undefined) {
        gitClient.basicAuth(gitHubUser, process.env.GITHUB_TOKEN);
        cb(null);
        return;
    }

    if (process.env.GITHUB_API_TOKEN_FILE === undefined) {
        if (PRR_CONFIG['gitHubApiTokenFile'] !== undefined) {
            gitHubAPITokenFile = PRR_CONFIG['gitHubApiTokenFile'];
        } else {
            gitHubAPITokenFile = '~/.github-api-token';
        }
    }

    gitHubAPITokenFile = expandTilde(gitHubAPITokenFile);

    fs.readFile(gitHubAPITokenFile, 'utf8', function(err, data) {
        if (err) {
            cb(new VError('failed to read %s: %s', gitHubAPITokenFile, err));
            return;
        }
        gitHubAPIToken = data.trim();
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
            if (TICKET_RE.test(title) || GITHUB_TICKET_RE.test(title)) {
                tickets[(title.split(' ')[0])] = pr.title;
            }
            // If we have a description, gather ticket lines from it.
            if (pr.body) {
                var descLines = pr.body.split('\n');
                descLines.forEach(function(line, _) {
                    if (TICKET_RE.test(line) || GITHUB_TICKET_RE.test(line)) {
                        tickets[(line.split(' ')[0])] = line;
                    }
                });
            }
            cb(null, submitter, title, tickets, state);
        }
        var submitter = pr.user.login;
        var title = pr.title.trim();
        var state = pr.state;
        if (TICKET_RE.test(title) || GITHUB_TICKET_RE.test(title)) {
            tickets[title.split(' ')[0]] = pr.title;
        }
        cb(null, submitter, title, tickets, state);
    });
}

/*
 * Gathers the commits pushed as part of this PR.
 *
 * @param {String} args.gitRepo - The github "username/repo" string.
 * @param {String} args.tickets - any existing ticket information we have.
 * @param {String} args.prNumber - the number of the beast^Wcommit message
 * @param {Boolean} args.allCommitMessages - add all commit message lines from
 *                                  the PR to the list of messages, rather than
 *                                  just the ones which appear to be
 *                                  ticket/synopsis pairs
 * @param {ArrayOfString} args.messages - any ticket synopses collected from
 *                                        the PR description or title
 * @param {Function} cb - callback
 */
function gatherPullRequestCommits(args, cb) {
    assert.object(args, 'args');
    assert.string(args.prNumber, 'args.prNumber');
    assert.object(args.tickets, 'args.tickets');
    assert.string(args.gitRepo, 'args.gitRepo');
    assert.bool(args.allCommitMessages, 'args.allCommitMessages');
    assert.arrayOfString(args.messages, 'args.messages');
    assert.func(cb, 'cb');

    gitClient.get(
        format('/repos/%s/pulls/%s/commits?per_page=100',
            args.gitRepo, args.prNumber),
        function getPr(err, req, res, commits) {
            if (err !== null) {
                console.log(
                    format(
                        'Unable to gather commits for %s#%s',
                        args.gitRepo,
                        args.prNumber
                    )
                );
                cb(err);
                return;
            }

            var messages = args.messages;

            commits.forEach(function processCommit(obj) {
                args.lastCommit = obj.sha;
                var lines = obj.commit.message.split('\n');
                lines.forEach(function extractTickets(line) {
                    if (TICKET_RE.test(line) || GITHUB_TICKET_RE.test(line)) {
                        // record the jira ticket and full line
                        args.tickets[line.split(' ')[0]] = line.trim();
                        messages.push(line.trim());
                    } else if (args.allCommitMessages) {
                        messages.push(line.trim());
                    }
                });
            });

        // Check that our first saved message (set to the title of the PR if
        // that title contained a valid ticket) isn't the same as the
        // the first commit message, a common scenario that would otherwise
        // result in duplicates. We can still get duplicates after this,
        // e.g. if the user pasted all bugs being fixed into the PR description
        // *and* also used each ticket/synopsis in subsequent commits, but that
        // seems less likely. We might want to revisit this.
        if (messages.length >= 2 && messages[0] === messages[1]) {
            args.messages = messages.slice(1);
        } else {
            args.messages = messages;
        }
        args.commits = commits;
        cb();
    });
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
        format('/repos/%s/pulls/%s/reviews?per_page=100',
            args.gitRepo, args.prNumber),
        function getReviews(err, req, res, reviews) {
            if (err !== null) {
                cb(err);
                return;
            }
            // we don't have a format Set object, so make do with this
            var reviewers = {};
            reviews.forEach(function processReview(obj) {
                if (obj.user.login !== args.submitter) {
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
 * @param {String} args.gitRepo - The github "username/repo" string.
 * @param {String} args.submitter - The username of the submitter
 * @param {String} args.prNumber - the number of the beast^Wcommit message
 * @param {Function} cb - `function (err, approvers)`
 */
function gatherApproverUsername(args, cb) {
    assert.object(args, 'args');
    assert.string(args.gitRepo, 'args.gitRepo');
    assert.string(args.submitter, 'args.submitter');
    assert.string(args.prNumber, 'args.prNumber');
    assert.func(cb, 'cb');

    gitClient.get(
        format('/repos/%s/issues/%s/events?per_page=100',
            args.gitRepo, args.prNumber),
        function getEvents(err, req, res, events) {
            if (err !== null) {
                cb(err);
                return;
            }
            // Given the way the GitHub events API works, there should only ever
            // be a single user associated with a label. Here, if userA
            // grants approval and userB revokes it, we record no approver.
            var approver = null;
            events.forEach(function processEvent(obj) {
                if (obj.actor.login === args.submitter) {
                    return;
                }
                if (
                    obj.event === 'labeled' &&
                    obj.label.name === 'integration-approval'
                ) {
                    approver = obj.actor.login;
                } else if (
                    obj.event === 'unlabeled' &&
                    obj.label.name === 'integration-approval'
                ) {
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
    mod_vasync.forEachParallel(
        {
            inputs: users,
            func: function handleOneLogin(login, nextLogin) {
                emailContactFromUsername({ user: login }, function(
                    err,
                    contact
                ) {
                    if (err) {
                        nextLogin(err);
                    } else {
                        userContacts[login] = contact;
                        nextLogin();
                    }
                });
            }
        },
        function doneAllLogins(err) {
            cb(err, userContacts);
        }
    );
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

    gitClient.get('/users/' + user, function getUser(err, req, res, userInfo) {
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

/*
 * Create and write to a temporary file containing the commit title and
 * commit message to be used when merging this pull request.
 *
 * @param {String} args.title - The title of this pull request
 * @param {String} args.reviewerContacts - a map of reviewers to their
 *                                         names/email addresses
 * @param {Array} args.messages - A list of strings containing the commit
 *                                messages for this review.
 * @param {String} args.prNumber - the number of the beast^Wcommit message
 * @param {Function} cb - `function (err, commit message file path)`
 */
function writeCommitMessage(args, cb) {
    assert.object(args, 'args');
    assert.string(args.title, 'args.title');
    assert.object(args.reviewerContacts, 'args.reviewerContacts');
    assert.optionalString(args.approverContact, args.approverContact);
    assert.arrayOfString(args.messages, 'args.messages');
    assert.string(args.prNumber, 'args.prNumber');
    assert.func(cb, 'cb');

    temp.open({ suffix: '.txt' }, function(err, info) {
        if (err) {
            cb(err);
            return;
        }

        // Often, PR titles are the same as the first commit message line in
        // the PR. Try to catch these cases by removing the first message line
        // if it's identical to the title as well as any blank lines in between.
        if (args.messages.length > 0) {
            var remaining_messages = args.messages;
            if (args.title === remaining_messages[0]) {
                remaining_messages = remaining_messages.slice(1);
            }

            if (remaining_messages.length > 0) {
                while (remaining_messages[0].trim() === '') {
                    remaining_messages = remaining_messages.slice(1);
                }
            }

            fs.writeSync(info.fd, format(
                '%s (#%s)\n\n', args.title, args.prNumber));
            if (remaining_messages.length > 0) {
                fs.writeSync(info.fd, remaining_messages.join('\n') + '\n');
            }
        } else {
            // no messages, so just use the title. This should be impossible
            // because surely every PR includes at least one commit?
            fs.writeSync(
                info.fd,
                format('%s (#%s)\n\n', args.title, args.prNumber)
            );
        }
        Object.keys(args.reviewerContacts)
            .sort()
            .forEach(function(reviewer) {
                fs.writeSync(
                    info.fd,
                    format('Reviewed by: %s\n', args.reviewerContacts[reviewer])
                );
            });
        if (args.approverContact) {
            fs.writeSync(
                info.fd,
                format('Approved by: %s\n', args.approverContact)
            );
        }
        fs.close(info.fd, function(errClose) {
            if (errClose) {
                cb(errClose);
                return;
            }
            cb(null, info.path);
        });
    });
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
 * @param {Function} cb - callback
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

        args.title = title;
        args.commitMessage = msg_lines.join('\n');
        cb();
    });
}

/*
 * We don't make any attempt to check if the terminal can actually handle this.
 */
function linkify(link, text) {
    return ('\x1B]8;;' + link + '\x1B\\' + text + '\x1B]8;;\x1B\\');
}

/*
 * Check if the user wants to go ahead with the merge, abort, or edit the commit
 * message.
 *
 * @param {String} args.commitMessage - the commit message
 * @param {Array} args.commits - the commits
 * @param {String} args.gitRepo - The github "username/repo" string.
 * @param {String} args.prNumber - the number of the beast^Wcommit message
 * @param {Function} cb - `function (err, user answer y/n)`
 */
function getAnswer(args, cb) {
    assert.object(args, 'args');
    assert.string(args.commitMessage, 'args.commitMessage');
    assert.array(args.commits, 'args.commits');
    assert.string(args.gitRepo, 'args.gitRepo');
    assert.string(args.prNumber, 'args.prNumber');
    assert.func(cb, 'cb');

    console.log(
        format('--- PR %s#%s commit message ---', args.gitRepo, args.prNumber)
    );
    console.log('');

    console.log(args.title);

    if (args.commitMessage) {
        // there may be a trailing newline on the commit message which
        // GitHub ignores, but try not to alarm the user.
        var emit = args.commitMessage;
        if (emit[emit.length - 1] === '\n') {
            emit = emit.slice(0, emit.length - 1);
        }
        console.log('\n' + emit);
    }

    console.log('');
    console.log('--- commits included ---');
    console.log('');
    args.commits.forEach(function(commit) {
        console.log(commit.sha + ' ' + commit.commit.message.split('\n')[0]);
    });

    var filesLink = format('https://github.com/%s/pull/%s/files', args.gitRepo,
        args.prNumber);

    console.log('');
    console.log('--- changes: ' + linkify(filesLink, filesLink) + ' ---');

    if (Object.keys(args.tickets).length > 0) {
        console.log(
            format('--- tickets: %s ---', Object.keys(args.tickets).join(', '))
        );
    }

    console.log('');

    var user_question = 'Squash and merge this PR? ([y]es/[e]dit/[q]uit)';
    var prompt_schema = {
        properties: {
            answer: {
                description: user_question,
                pattern: /^yes|edit|quit|y|e|q$/,
                message: 'please answer y, e, or q',
                required: true
            }
        }
    };
    prompt.colors = false;
    prompt.message = '';
    prompt.start();
    prompt.get(prompt_schema, function user_input(prompt_err, result) {
        if (prompt_err) {
            args.abort = true;
        } else if (result.answer[0] === 'y') {
            args.commitMessageAccepted = true;
        } else if (result.answer[0] === 'e') {
            args.commitMessageAccepted = false;
        } else if (result.answer[0] === 'q') {
            args.abort = true;
        }

        cb();
    });
}

/*
 * Invoke $EDITOR or `vi` on the commit message synchronously.
 *
 * @param {String} args.commitMessagePath - The file path to edit
 * @param {Function} cb - callback
 */
function editCommitMessage(args, cb) {
    assert.object(args, 'args');
    assert.string(args.commitMessagePath, 'args.commitMessagePath');
    assert.func(cb, 'cb');

    if (args.commitMessageAccepted || args.abort) {
        cb();
        return;
    }

    var editor = process.env.EDITOR || 'vi';
    // allow arguments in messages
    var editor_toks = editor.split(' ');
    // modify the commit message
    var editor_args = [];
    if (editor_toks.length > 1) {
        editor_args = editor_toks.slice(1);
    }
    editor_args.push(args.commitMessagePath);
    var child = child_process.spawnSync(editor_toks[0], editor_args, {
        stdio: 'inherit'
    });
    if (child.error) {
        cb(child.error);
        return;
    }
    cb();
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
    // prettier-ignore
    mod_vasync.whilst(
        function guard() {
            if (arg.abort) {
                console.log('aborting merge');
                process.exit(1);
            }

            if (!arg.commitMessageAccepted) {
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
                    readCommitMessage,
                    getAnswer,
                    editCommitMessage
                ]},
                function pipelineResults(err, results) {
                    if (err) {
                        nextLoop(new VError(
                            format(
                                'problem editing commit message: %s',
                                err.message)), null);
                        return;
                    }
                    nextLoop(null, arg);
                }
            );
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
        merge_method: 'squash',
        sha: args.lastCommit,
        commit_title: args.title,
        commit_message: args.commitMessage
    });

    gitClient.put(
        format('/repos/%s/pulls/%s/merge', args.gitRepo, args.prNumber),
        {
            merge_method: 'squash',
            sha: args.lastCommit,
            commit_title: args.title,
            commit_message: args.commitMessage
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

function usage(parser) {
    var help = parser.help({ includeEnv: true }).trimRight();
    console.log(
        'Usage: prr [options] <pull request number>\n' + 'options:\n' + help
    );
    process.exit(2);
}

function prrConfigDefault(key, defaultValue) {
    if (PRR_CONFIG[key] !== undefined) {
        return PRR_CONFIG[key];
    }
    return defaultValue;
}

// main

// Specify the options. Minimally `name` (or `names`) and `type`
// must be given for each. Note that cliOptions long-names should be
// kept in sync with defaultOptions and the values in ~/.prrconfig
var cliOptions = [
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
        names: ['allCommitMessages', 'M'],
        type: 'bool',
        help:
            'Use all lines of the commit messages from the PR in the ' +
            'summary, rather than just those with tickets',
        default: prrConfigDefault('allCommitMessages', false)
    },
    {
        names: ['verbose', 'v'],
        type: 'arrayOfBool',
        help: 'Verbose output.'
    }
];

var context = {};
var parser = dashdash.createParser({ options: cliOptions });
try {
    var opts = parser.parse(process.argv);

    if (opts.verbose) {
        log.level(bunyan.DEBUG);
    }
    if (opts.help) {
        usage(parser);
    }
    if (opts._args.length !== 1) {
        console.log('Error: missing pr number');
        usage(parser);
    }
    if (opts.gitrepo) {
        context.repoPath = expandTilde(opts.gitrepo);
    }
    if (opts.allCommitMessages) {
        context.allCommitMessages = opts.allCommitMessages;
    } else {
        context.allCommitMessages = false;
    }
    context.prNumber = opts._args[0];
} catch (e) {
    console.error('prr: error: %s', e.message);
    process.exit(1);
}

// prettier-ignore
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
        // eslint-disable-next-line no-unused-vars
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
                    // We may have gathered commit message lines from the
                    // PR description or title, record those.
                    arg.messages = Object.values(tickets);
                    next();
                });
        },
        gatherPullRequestCommits,
        function getReviewerUsernames(arg, next) {
            gatherReviewerUsernames(arg,
                function collectPRReviewers(err, reviewers) {
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
                    return;
                }
            });
        }
    ]
}, function (err, results) {
        if (err) {
            console.log(format('Error: %s', err.message));
            process.exit(1);
        }
       log.debug(JSON.stringify(results));
});
