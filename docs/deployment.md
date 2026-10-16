# Production CD

`main` pushes run `.github/workflows/cd.yml`. A trusted `verify` job runs `npm test`,
`npx tsc -b`, lint, formatting, build, and the deployment dry run, then packages the
validated `dist/` tree. A separate `deploy` job (production environment) sends that
archive over SSH with a pinned host key. Pull requests never run this workflow and
never receive deployment secrets.

## Server boundary

The receiver is installed outside the checkout at `/usr/local/libexec/`:

- `receive-deploy.js` is root-owned and executable only through the exact sudo
  command in `/etc/sudoers.d/solux-deploy`.
- `deploy.js` is the root-owned copy of `scripts/deploy.js`.
- `/var/lib/solux-deploy/staging` is root-owned mode `0700`; the run state is
  `/var/lib/solux-deploy/state.json` mode `0600`.
- `solux-deploy` has no password, no useful interactive shell, no writable home or
  receiver files, and one authorized key with forced command,
  `no-port-forwarding`, `no-agent-forwarding`, `no-X11-forwarding`, `no-pty`, and
  `no-user-rc` options. Its only sudo rule is the exact `flock`-wrapped receiver.

The receiver bounds the compressed/uncompressed archive, accepts only regular files
and directories, rejects absolute, traversal, duplicate, broken, symlink, hardlink,
and special-file entries, requires the repository/run metadata, validates the extracted
PWA using the deployment script, and deploys under a non-overlapping `flock`. It does
not execute anything from the archive. Run IDs are persisted and older/replayed runs
are rejected. `scripts/deploy.js` preserves old hashed assets and atomically promotes
lifecycle files. No Nginx or service reload is part of CD.

The host key variable is the complete known-hosts line for `ssh.archnet.lol`. It was
obtained from the server's local `/etc/ssh/ssh_host_ed25519_key.pub`, not from an
unverified network scan. Current ED25519 fingerprint: `SHA256:jfaLLNGm3tjXEWFnwvu3pNZ22uqE9i2RTPeNG9n8abo`.

## Setup and rotation

As an administrator, create the system account, root-owned staging/state directories,
receiver copies (`receive-deploy.js` beside `deploy.js`), exact sudo rule, and
root-owned authorized-keys file. The authorized key line must retain the forced-command and all `no-*` restrictions above. Validate the
sudo file with `visudo -cf`; do not grant the account general sudo or webroot write
access. Install the receiver source only through a root-owned temporary file and set
mode `0755` after review.

Create a fresh local Ed25519 key with `umask 077`, install only its public key, and set
these GitHub repository values (never log or commit the private key):

- Secret: `SOLUX_DEPLOY_PRIVATE_KEY`
- Variable: `SOLUX_DEPLOY_HOST_KEY`

Set the host variable to `ssh.archnet.lol ssh-ed25519 <key> root@aslan`, then securely
delete the local private-key copy after verifying the secret. Rotate by installing the
new forced key, updating the secret, testing a payload, and removing the old key. The
existing `~/.ssh/github_actions_deploy` key is an administrator/recovery key and is
not used by CD or modified by setup.

## Recovery and checks

Before activation, test with a scratch archive against a scratch target by calling the
exported receiver validator/extractor, and verify a new-key SSH shell attempt returns
an archive error, forwarding is administratively prohibited, and the account cannot
write `/usr/local/libexec`, sudoers, staging, or state. Keep administrative recovery
copies outside `/var/www/solux`.

There is intentionally no release registry or automated rollback. A failed receiver
leaves the prior lifecycle files in place; a successful deployment retains old hashed
assets for active tabs. To roll back, revert the offending change on `main` and let the
new main run pass verification, or use the existing administrator deployment procedure
with a previously retained build. Do not delete old assets while active sessions may
need them. The receiver/state/authorized-key changes can be rolled back by removing the
Solux sudoers file, key, account, and `/var/lib/solux-deploy` after confirming no run is
active; this does not alter the current webroot or Nginx.
