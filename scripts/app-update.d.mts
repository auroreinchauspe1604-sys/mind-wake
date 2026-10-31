export interface UpdateResult {
  state: string;
  revision?: string;
  message?: string;
  restartRequired?: boolean;
  checkedAt?: string;
  development?: boolean;
}
export const UPDATE_INTERVAL: number;
export function development(
  manifest: { development?: boolean },
  env?: Record<string, string | undefined>,
): boolean;
export function updateStatus(file: string): UpdateResult;
export function checkUpdate(
  file: string,
  options?: {
    run?: (exe: string, args: string[], cwd: string, log: number) => Promise<string>;
    expectedRevision?: string;
    beforeStep?: () => void | Promise<void>;
  },
): Promise<UpdateResult>;
