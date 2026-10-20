/** cwd 在工作树里时返回这一路的分支与位置；在主目录或不在 Git 里返回 null */
export function laneOf(cwd: string): { branch: string; worktree: string } | null
