/**
 * Config every git call the app makes adds, because it runs in folders an agent can write to and a
 * repository's own config (`.git/config`) could otherwise make git start programs:
 *  - `core.fsmonitor=false`: `fsmonitor` is a command git runs on `status`, `diff` and more;
 *  - `safe.bareRepository=explicit`: a folder shaped like a bare repository inside a work tree is
 *    not picked up by discovery (a bare repository must be named with `--git-dir`);
 *  - `protocol.ext.allow=never`: the `ext::` transport runs a command named in a remote URL.
 * External diff and textconv drivers are refused per diff command (`--no-ext-diff`, `--no-textconv`).
 * Credential helpers and SSH are untouched, so fetches keep working.
 */
export const GIT_HARDENING = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit', '-c', 'protocol.ext.allow=never']
