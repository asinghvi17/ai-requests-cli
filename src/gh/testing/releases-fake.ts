// In-memory Releases for tests: release assets, filed issues and repo-wide comments of one repo.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { GhError } from '../gh.ts';
import type { Asset, IssueSummary, Releases, RepoComment } from '../releases.ts';

export interface FakeAsset extends Asset {
  tag: string;
  /** The uploaded bytes. */
  data?: Buffer;
}

export interface FiledIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface FakeReleases extends Releases {
  assetsByTag: Map<string, FakeAsset[]>;
  issueList: IssueSummary[];
  commentList: RepoComment[];
  filed: FiledIssue[];
  /** Every mutating call, as `method arg`. */
  log: string[];
  /** Asset ids whose delete fails with a server error. */
  failDelete: Set<number>;
  addAsset(tag: string, name: string, size?: number): FakeAsset;
}

export function fakeReleases(repo = 'o/requests', opts: { host?: string } = {}): FakeReleases {
  const host = opts.host ?? 'github.com';
  let nextId = 1;
  const assetsByTag = new Map<string, FakeAsset[]>();
  const add = (tag: string, name: string, size: number, data?: Buffer): FakeAsset => {
    const a: FakeAsset = { id: nextId++, tag, name, size, url: `https://${host}/${repo}/releases/download/${tag}/${name}` };
    if (data) a.data = data;
    if (!assetsByTag.has(tag)) assetsByTag.set(tag, []);
    assetsByTag.get(tag)!.push(a);
    return a;
  };
  const strip = ({ tag: _t, data: _d, ...a }: FakeAsset): Asset => a;
  const fake: FakeReleases = {
    repo, assetsByTag, issueList: [], commentList: [], filed: [], log: [], failDelete: new Set(),
    addAsset: (tag, name, size = 100) => add(tag, name, size),
    async assets(tag) {
      return (assetsByTag.get(tag) ?? []).map(strip);
    },
    async upload(tag, file) {
      const name = basename(file);
      fake.log.push(`upload ${tag} ${name}`);
      if ((assetsByTag.get(tag) ?? []).some((a) => a.name === name)) throw new GhError('validation', 'already_exists (HTTP 422)', 422);
      const data = readFileSync(file);
      return strip(add(tag, name, data.length, data));
    },
    async deleteAsset(id) {
      fake.log.push(`deleteAsset ${id}`);
      if (fake.failDelete.has(id)) throw new GhError('server', 'Server Error (HTTP 502)', 502);
      for (const list of assetsByTag.values()) {
        const k = list.findIndex((a) => a.id === id);
        if (k >= 0) list.splice(k, 1);
      }
    },
    async createIssue(title, body, labels) {
      fake.log.push(`createIssue ${title}`);
      const number = fake.issueList.length + fake.filed.length + 1;
      fake.filed.push({ number, title, body, labels });
      return { number, url: `https://${host}/${repo}/issues/${number}` };
    },
    async issues() {
      return fake.issueList.map((i) => ({ ...i, labels: [...i.labels] }));
    },
    async comments() {
      return fake.commentList.map((c) => ({ ...c }));
    },
  };
  return fake;
}
