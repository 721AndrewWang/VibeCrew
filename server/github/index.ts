// GitHub as an asynchronous channel (ADR 102): a Trigger source that polls opted-in projects'
// repositories, and draft-only output the Router writes for it.

export { closeGithub, githubStatuses, pollGithub, startGithub, syncGithub } from './poller';
