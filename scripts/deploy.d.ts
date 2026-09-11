export interface DeployOptions {
  distDir?: string;
  targetDir?: string;
  dryRun?: boolean;
  fileMode?: number;
  dirMode?: number;
  logger?: (msg: string) => void;
}

export interface DeployResult {
  success: boolean;
  dryRun: boolean;
  validated: boolean;
  distDir: string;
  targetDir: string;
  assetsCopied?: number;
  staticFilesCopied?: number;
  lifecyclePromoted?: number;
}

export interface ParsedArgs {
  distDir: string;
  targetDir: string;
  dryRun: boolean;
  help: boolean;
}

export const DEFAULT_TARGET_DIR: string;
export const REQUIRED_FILES: string[];
export const LIFECYCLE_FILES: string[];

export function checkSymlinks(currentDir: string, rootDistDir?: string): void;
export function validateDist(distDir: string): void;
export function deploy(options?: DeployOptions): DeployResult;
export function parseArgs(argv: string[]): ParsedArgs;
