# Security policy

## Report a vulnerability

Do not report a vulnerability in a public issue, a discussion or a pull request. Use the private vulnerability report of GitHub:

1. Open the **Security** tab of [ottr-ai/ottr](https://github.com/ottr-ai/ottr).
2. Click **Report a vulnerability**.
3. Give the affected commit or release, the steps to reproduce, and the impact.

## Supported versions

Only the newest release and the newest commit on `main` get security fixes.

## Scope

Ottr runs coding agents with full shell access in your projects, and it stores credentials in its tracker database (see [Requirements](README.md#requirements)). This is by design. A vulnerability is a way to get more access than the owner of the board gave, for example to use the board or its API without a login, or to read a stored credential.
