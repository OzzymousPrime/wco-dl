// Free space where downloads land (17 Nov 2026). Nothing checked it, and on a machine where the downloads share a
// drive with everything else (Docker's own disk, on the homelab this was written for), a full drive stops more than
// this app. Below MIN_FREE_GB nothing new starts: no fill-queue episode and no Browse download.
import { HttpException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface DiskState {
  /** Free space in GB as Windows Explorer and most file managers count it (1024³ bytes); undefined when unreadable. */
  freeGb?: number;
  /** The limit; 0 turns the check off. */
  minGb: number;
  low: boolean;
}

/** Free space at dir, in GB (1024³ bytes): of its nearest folder that exists (the downloads folder may not yet), or undefined. */
export async function freeGb(dir: string): Promise<number | undefined> {
  for (let at = path.resolve(dir), i = 0; i < 64; i++) {
    try {
      const s = await fs.statfs(at);
      return (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3;
    } catch {
      const up = path.dirname(at);
      if (up === at) return undefined;
      at = up;
    }
  }
  return undefined;
}

/** Unreadable space is never "low": a check that cannot measure must not stop downloads. */
export function judgeDisk(free: number | undefined, minGb: number): DiskState {
  return {
    freeGb: free === undefined ? undefined : Math.floor(free * 10) / 10,
    minGb,
    low: minGb > 0 && free !== undefined && free < minGb,
  };
}

export async function diskState(dir: string, minGb: number): Promise<DiskState> {
  return judgeDisk(minGb > 0 ? await freeGb(dir) : undefined, minGb);
}

export function lowDiskMessage(d: DiskState): string {
  return `Only ${d.freeGb} GB free where downloads go, under the ${d.minGb} GB limit (MIN_FREE_GB): nothing new starts until there is room`;
}

/** For a request that would start a download: 507 Insufficient Storage, with the reason in words. */
export async function assertSpace(dir: string, minGb: number): Promise<void> {
  const d = await diskState(dir, minGb);
  if (d.low) throw new HttpException(lowDiskMessage(d), 507);   // Insufficient Storage
}
