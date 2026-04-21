# Security Policy

## Reporting a vulnerability

If you find a security issue in Horizon Genesis, please **do not open a public GitHub issue**. Instead, email:

**ernest2011kostevich@gmail.com**

Include:
- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- Your OS and Horizon version
- (Optional) A suggested fix

I'll acknowledge within 72 hours and aim to patch critical issues within 7 days.

## Scope

In scope:
- Arbitrary code execution via plugin manifest / handler
- Permission escalation beyond declared plugin capabilities
- Secret leaks (API keys, tokens) from `electron-store` or `safeStorage`
- Protocol handler (`horizon://`) exploits
- IPC boundary violations between main and renderer processes
- Insecure defaults in packaged installers

Out of scope:
- Issues in user-installed community plugins (report to the plugin author)
- Social engineering / phishing targeting the user
- Physical access attacks (if someone has your unlocked laptop, it's over)
- Vulnerabilities in upstream dependencies — please report to the dep first

## Supported versions

Only the **latest release** receives security patches. Running on an older version? Upgrade first.

## Disclosure

I'll credit the reporter in the release notes unless they prefer anonymity. No bounty program — this is a solo project.
