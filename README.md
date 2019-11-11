# prr
Tooling to assist with GitHub pull requests

Prr provides command line assistance when merging Joyent pull requests on GitHub.

## Usage

```
$ ./bin/prr -h
Usage: prr [options] <pull request number>
options:
    -h, --help               Print this help and exit.
    -C ARG, --gitrepo=ARG    A path to the local git repository to act upon.
    -M, --allCommitMessages  Use all lines of the commit messages from the PR in
                             the summary, rather than just those with jira
                             tickets.
    -v, --verbose            Verbose output.
```

When run from the top-level of a GitHub repository with a pull request number
as an argument, it does the following:

* gathers a list of reviewers and their email addresses from the PR
* gathers all commit messages for that PR, writing them to a temporary file
* writes "Reviewed by:" tags to the commit messages for all reviewers to the
  temporary file
* if the PR has been labelled with the GitHub `integration-approval`, it adds
  an 'Approved by:" tag to the commit message.
* Launches `$EDITOR` on the file to allow you to modify it
* After you save and close the editor, it emits the commit message as asks if
  it's correct
* If it is, it then invokes the GitHub 'merge' API to 'squash and merge' the
  pull request.

If user details are not available to prr because the data isn't present on
a user's public GitHub profile (for example, full user names or email addresses)
then only the username will be included in the generated commit message.

Either the `$GITREPO` environment variable or the `-C` option can be used to
specify the path to git repository to use. prr does **not** modify anything
in that repository, but merely uses the `.git/config` file in that repository
to lookup the remote `origin` in order to construct the correct URLs when
making GitHub REST API calls.

If `-M` is passed, all commit messages from the PR are written to the temporary
file, otherwise only messages which match the regular expression
`'^[A-Z]+-[0-9]+ '` (e.g. "`JIRA-1234 this is a ticket synopsis`") are included.

Note that prr enforces only a single approver for any given pull request.

## Configuration

If you have previously set up [hub(1)](https://hub.github.com/), `prr` can use
its configuration file to derive the github user and API token.

Alternatively, you can create a configuration file `$HOME/.prrconfig` which
looks like this:

```
{
    "gitHubUser": "joeuser",
    "gitHubApiTokenFile": "~/.github-api-token",
    "userEmail": {
        "anonreviewer1": "foo.bar@email.com",
        "anonreviewer2": "bar.baz@email.com"
    },
    "allCommitMessages": false
}
```

* `gitHubUser` is the username you login to GitHub with
* `gitHubApiTokenFile` is a flat file containing a GitHub API token for
  interaction with GitHub. [Create one here](https://github.com/settings/tokens)
* `userEmail` is a mapping of GitHub User logins to email addresses. If this is
  not set, prr will use the public email address on the user's GitHub profile.

## Install

    npm install

## License

MPL 2.0
