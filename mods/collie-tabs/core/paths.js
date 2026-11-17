// A task worktree's path is kept out of lists of folders people work in. This is the only path
// helper the collie window still needs.
export const WORKTREE_RE = /\/\.herdr\/worktrees\//;
export const isWorktreePath = (p) => !!p && WORKTREE_RE.test(`${p}/`);
