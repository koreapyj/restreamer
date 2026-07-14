/*
 * 'raw-argv' template: {OUT_DIR} token substitution and the progress-channel
 * append, exercised via the public template registry (mirrors how the
 * pipeline builder invokes it).
 */

import { describe, expect, it } from 'vitest';
import type { RawArgvParams } from '../src/contract/v1.js';
import { getTemplate } from '../src/pipeline/templates/index.js';

function params(overrides: Partial<RawArgvParams> = {}): RawArgvParams {
  return {
    template: 'raw-argv',
    templateVersion: 1,
    ffmpegArgv: ['-i', '-', '-f', 'hls', '{OUT_DIR}/%v/stream.m3u8'],
    ...overrides,
  };
}

describe("template 'raw-argv'", () => {
  const template = getTemplate(params());

  it('substitutes an {OUT_DIR} token embedded within a larger token', () => {
    const argv = template.build(params({ ffmpegArgv: ['{OUT_DIR}/%v/stream.m3u8'] }), { outDir: '/media/foo' });
    expect(argv).toEqual(['/media/foo/%v/stream.m3u8']);
  });

  it('substitutes a whole-token {OUT_DIR}', () => {
    const argv = template.build(params({ ffmpegArgv: ['{OUT_DIR}'] }), { outDir: '/media/foo' });
    expect(argv).toEqual(['/media/foo']);
  });

  it('substitutes multiple {OUT_DIR} occurrences within one token', () => {
    const argv = template.build(params({ ffmpegArgv: ['{OUT_DIR}/a:{OUT_DIR}/b'] }), { outDir: '/media/foo' });
    expect(argv).toEqual(['/media/foo/a:/media/foo/b']);
  });

  it('passes a token without the marker through unchanged', () => {
    const argv = template.build(params({ ffmpegArgv: ['-hide_banner'] }), { outDir: '/media/foo' });
    expect(argv).toEqual(['-hide_banner']);
  });

  it('appends -progress pipe:3 only when ctx.progress is true', () => {
    const withoutProgress = template.build(params({ ffmpegArgv: ['-i', '-'] }), { outDir: '/media/foo' });
    expect(withoutProgress).toEqual(['-i', '-']);

    const withProgress = template.build(params({ ffmpegArgv: ['-i', '-'] }), {
      outDir: '/media/foo',
      progress: true,
    });
    expect(withProgress).toEqual(['-i', '-', '-progress', 'pipe:3']);
  });

  it('does not mutate the input argv array in place', () => {
    const p = params({ ffmpegArgv: ['{OUT_DIR}/x'] });
    const snapshot = [...p.ffmpegArgv];
    template.build(p, { outDir: '/media/foo', progress: true });
    expect(p.ffmpegArgv).toEqual(snapshot);
  });

  it('is registered under id raw-argv, version 1, with no required capabilities', () => {
    expect(template.id).toBe('raw-argv');
    expect(template.version).toBe(1);
    expect(template.requiredCaps).toEqual([]);
  });
});
