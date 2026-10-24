import { describe, expect, it } from 'vitest';
import { appendRecord, createRecord } from '@xiangqi/rules';
import { GameArchive } from './archive.ts';

describe('browser game archive', () => {
  it('survives a new repository instance with the whole local move history', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const archive = new GameArchive(storage);
    const record = appendRecord(createRecord('local'), 'h2e2');
    expect(archive.save({ mode: 'local', record })).toBe(true);
    const reloaded = new GameArchive(storage);
    expect(reloaded.activeLocal()?.record).toEqual(record);
    expect(reloaded.valid(reloaded.activeLocal()!)).toBe(true);
  });
  it('keeps private resume credentials when a later position update is saved', () => {
    const data = new Map<string, string>();
    const archive = new GameArchive({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } });
    const record = createRecord('online');
    archive.save({ mode: 'online', roomCode: 'ABCD', resumeToken: 'private', seat: 'red', record });
    archive.save({ mode: 'online', roomCode: 'ABCD', record: appendRecord(record, 'h2e2') });
    expect(archive.entries()[0].resumeToken).toBe('private');
    expect(archive.entries()).toHaveLength(1);
  });
  it('reports quota failure and tolerates corrupt storage', () => {
    const archive = new GameArchive({ getItem: () => '{broken', setItem: () => { throw new Error('quota'); } });
    expect(archive.entries()).toEqual([]);
    expect(archive.save({ mode: 'local', record: createRecord('test') })).toBe(false);
  });
  it('keeps both seat credentials when two players use tabs in the same browser', () => {
    const data = new Map<string, string>();
    const archive = new GameArchive({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } });
    const record = createRecord('shared-browser');
    archive.save({ mode: 'online', record, seat: 'red', resumeToken: 'red-key' });
    archive.save({ mode: 'online', record, seat: 'black', resumeToken: 'black-key' });
    expect(archive.entries()).toHaveLength(2);
    expect(archive.entries().find(entry => entry.seat === 'red')?.resumeToken).toBe('red-key');
    expect(archive.entries().find(entry => entry.seat === 'black')?.resumeToken).toBe('black-key');
  });
  it('does not silently evict older unfinished games after 200 records', () => {
    const data = new Map<string, string>();
    const archive = new GameArchive({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } });
    for (let i = 0; i < 201; i++) archive.save({ mode: 'local', record: createRecord(`game-${i}`) });
    expect(archive.entries()).toHaveLength(201);
    expect(archive.entries().some(entry => entry.record.id === 'game-0')).toBe(true);
  });

});
