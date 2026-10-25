import { describe, expect, it } from 'vitest';
import sample from '../../../fixtures/golden/sample.json';
import type { ChangeGraph } from '@lens/core';
import { diffForLeaf, edgesFor, groupByFile, hunksForContainer, hunksForLeaf, indexGraph } from './graphUtils.js';

const g = sample as unknown as ChangeGraph;
const idx = indexGraph(g);

describe('graphUtils', () => {
  it('finds hunks by range overlap for symbols with no owned hunk', () => {
    const ttl = idx.byId.get('symbol:src/services/invitations/token.ts#INVITE_TTL_MS')!;
    expect(hunksForLeaf(g, ttl).length).toBeGreaterThan(0);
  });
  it('collects descendant hunks for a cluster, grouped by file', () => {
    const c = idx.byId.get('cluster:invite-email')!;
    const files = groupByFile(hunksForContainer(g, idx, c));
    expect(files.map((f) => f.path)).toEqual(['src/services/email/invite.ts', 'src/services/email/mailer.ts']);
  });
  it('lists boundary-crossing edges for containers', () => {
    const m = idx.byId.get('module:web')!;
    expect(edgesFor(g, idx, m).some((r) => r.other.id.includes('createInvitationRoute'))).toBe(true);
  });
  it('diff panel: own hunks in full, overlapping foreign hunks only as links', () => {
    const cls = idx.byId.get('symbol:src/services/invitations/service.ts#InvitationService')!;
    const d = diffForLeaf(g, idx, cls);
    expect(d.own.map((h) => h.id)).toEqual(['hunk:6', 'hunk:27']);
    expect(d.alsoTouches.map((a) => a.owner.label)).toEqual(expect.arrayContaining(['InvitationService.createInvitation']));
    expect(d.alsoTouches.every((a) => a.hunk.owner !== cls.id)).toBe(true);
    const method = idx.byId.get('symbol:src/services/invitations/service.ts#InvitationService.createInvitation')!;
    expect(diffForLeaf(g, idx, method).own.map((h) => h.id)).toEqual(['hunk:7']);
  });
  it('a symbol without owned hunks only links to the owner of the overlapping hunk', () => {
    const ttl = idx.byId.get('symbol:src/services/invitations/token.ts#INVITE_TTL_MS')!;
    const d = diffForLeaf(g, idx, ttl);
    expect(d.own).toEqual([]);
    expect(d.alsoTouches.map((a) => a.owner.label)).toEqual(['generateToken']);
  });
});
