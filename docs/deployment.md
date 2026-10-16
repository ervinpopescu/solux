# Production CD

`main` pushes run `.github/workflows/cd.yml`. A trusted `verify` job runs `npm test`,
`npx tsc -b`, lint, formatting, build, and the deployment dry run, then packages the
validated `dist/` tree. A separate `deploy` job (production environment) sends that
archive over SSH with a pinned host key, then verifies both the 204 health endpoint and
the served hashed JavaScript bytes against the payload. Pull requests never run this
workflow and never receive deployment secrets.

## Server boundary

The receiver is installed outside the checkout at `/usr/local/libexec/`:

- `receive-deploy.js` and `deploy.js` are root-owned mode `0755`; the account cannot
  modify either file. The forced key runs only `/usr/bin/flock` and the receiver.
- `/var/lib/solux-deploy/staging` and `/var/lib/solux-deploy/state` are mode `0700`;
  `state/state.json` and `lock` are mode `0600`, owned by `solux-deploy`, and outside
  the webroot.
- `solux-deploy` has no password, no useful interactive shell, no writable home or
  receiver files, no sudoers entry, and one authorized key with forced command,
  `no-port-forwarding`, `no-agent-forwarding`, `no-X11-forwarding`, `no-pty`, and
  `no-user-rc` options.
- Access ACLs grant only `solux-deploy` directory traversal/write on `/var/www/solux`
  and `assets`; `ervin` remains owner and Nginx remains a reader. Deployment uses
  fresh temporary files and rename replacement, so existing destination symlinks,
  nonregular paths, and unsafe ancestors are rejected before modification.

The unprivileged receiver bounds the compressed/uncompressed archive, accepts only
regular files and directories, rejects absolute, traversal, duplicate, broken, symlink,
hardlink, and special-file entries, requires the repository/run metadata, validates the
extracted PWA using the root-owned deployment script, and deploys under a non-overlapping
`flock`. It does not execute anything from the archive. Run IDs are persisted and
older/replayed runs are rejected. `scripts/deploy.js` preserves old hashed assets and
uses fresh temporary files plus atomic rename for each promoted file. Each promotion is
atomic, but a process failure between files can still leave a mixed lifecycle set; this
is not a full multi-file transaction. No Nginx or service reload is part of CD.

The host key variable is the complete known-hosts line for `ssh.archnet.lol`. It was
obtained from the server's local `/etc/ssh/ssh_host_ed25519_key.pub`, not from an
unverified network scan. Current ED25519 fingerprint: `SHA256:jfaLLNGm3tjXEWFnwvu3pNZ22uqE9i2RTPeNG9n8abo`.

## Setup and rotation

As an administrator, create the system account, its private staging/state/lock
paths, root-owned receiver/deployer copies, ACLs, and root-owned authorized-keys file.
The authorized key line must retain the forced command and all `no-*` restrictions above.
Do not create a sudoers entry for this account or grant it arbitrary webroot/file access.
Install the receiver source only through a root-owned temporary file and set mode `0755`
after review. Back up the existing webroot ACL/config before changing ACLs; restore the
backup with `setfacl --restore=<private-backup>` if setup must be reverted.

Create a fresh local Ed25519 key with `umask 077`, install only its public key, and set
these GitHub values (never log or commit the private key):

- Production environment secret: `SOLUX_DEPLOY_PRIVATE_KEY`
- Repository variable: `SOLUX_DEPLOY_HOST_KEY`

The `production` environment is restricted to the `main` branch without a mandatory
reviewer gate; the trusted-main assumption is deliberate for this solo-maintainer
repository. The repository-level copy of the private secret must be absent.

Set the host variable to `ssh.archnet.lol ssh-ed25519 <key> root@aslan`, then securely
delete the local private-key copy after verifying the secret. Rotate by installing the
new forced key, updating the secret, testing a payload, and removing the old key. The
existing `~/.ssh/github_actions_deploy` key is an administrator/recovery key and is
not used by CD or modified by setup.

## Recovery and checks

Before activation, test the exact workflow tar command against a scratch target and
verify a new-key SSH shell attempt returns an archive error, forwarding is
administratively prohibited, `sudo -l` fails, and the account cannot write
`/usr/local/libexec`, authorized keys, or unrelated webroot paths. Keep administrative
recovery copies outside `/var/www/solux`.

There is intentionally no release registry or broad rollback machinery. Each receiver
file replacement is atomic, but a failure between lifecycle files can leave a mixed
set; the prior files are not guaranteed as a complete set. Successful deployments
retain old hashed assets for active tabs. To roll back, revert the offending change on
`main` and let the new main run pass verification, or use the existing administrator
break-glass deployment procedure with a previously retained build. That manual path is
intentionally outside CD locking/run-id ordering and must be coordinated by the
administrator. Do not delete old assets while active sessions may need them. The
receiver/key/account/ACL changes can be restored from the private backup or removed
after confirming no run is active; this does not alter Nginx.
