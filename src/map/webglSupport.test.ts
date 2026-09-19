import { describe, it, expect, vi, afterEach } from 'vitest';
import { isWebGL2Supported } from './webglSupport';

describe('isWebGL2Supported', () => {
  const originalWebGL2 = window.WebGL2RenderingContext;

  afterEach(() => {
    window.WebGL2RenderingContext = originalWebGL2;
    vi.restoreAllMocks();
  });

  it('returns false when WebGL2RenderingContext is not defined in window', () => {
    // @ts-expect-error - simulating browser without WebGL2
    delete window.WebGL2RenderingContext;

    const mockMap = {
      getCanvas: () => document.createElement('canvas'),
    };
    expect(isWebGL2Supported(mockMap)).toBe(false);
  });

  it('returns true when map.painter.context.gl is an instance of WebGL2RenderingContext', () => {
    class FakeWebGL2Context {}
    // @ts-expect-error - mock class
    window.WebGL2RenderingContext = FakeWebGL2Context;

    const mockGl = new FakeWebGL2Context();
    const mockMap = {
      getCanvas: () => document.createElement('canvas'),
      painter: { context: { gl: mockGl } },
    };

    expect(isWebGL2Supported(mockMap)).toBe(true);
  });

  it('returns false when map.painter.context.gl is not an instance of WebGL2RenderingContext', () => {
    class FakeWebGL2Context {}
    class FakeWebGL1Context {}
    // @ts-expect-error - mock class
    window.WebGL2RenderingContext = FakeWebGL2Context;

    const mockGl = new FakeWebGL1Context();
    const mockMap = {
      getCanvas: () => document.createElement('canvas'),
      painter: { context: { gl: mockGl } },
    };

    expect(isWebGL2Supported(mockMap)).toBe(false);
  });

  it('falls back to canvas.getContext("webgl2") when painter is not present', () => {
    class FakeWebGL2Context {}
    // @ts-expect-error - mock class
    window.WebGL2RenderingContext = FakeWebGL2Context;

    const fakeGl = new FakeWebGL2Context();
    const mockCanvas = {
      getContext: vi.fn((type: string) => (type === 'webgl2' ? fakeGl : null)),
    } as unknown as HTMLCanvasElement;

    const mockMap = {
      getCanvas: () => mockCanvas,
    };

    expect(isWebGL2Supported(mockMap)).toBe(true);
    expect(mockCanvas.getContext).toHaveBeenCalledWith('webgl2');
  });

  it('returns false when canvas.getContext("webgl2") returns null', () => {
    class FakeWebGL2Context {}
    // @ts-expect-error - mock class
    window.WebGL2RenderingContext = FakeWebGL2Context;

    const mockCanvas = {
      getContext: vi.fn(() => null),
    } as unknown as HTMLCanvasElement;

    const mockMap = {
      getCanvas: () => mockCanvas,
    };

    expect(isWebGL2Supported(mockMap)).toBe(false);
  });

  it('returns false when canvas is not available or throws', () => {
    class FakeWebGL2Context {}
    // @ts-expect-error - mock class
    window.WebGL2RenderingContext = FakeWebGL2Context;

    const mockMap = {
      getCanvas: () => {
        throw new Error('canvas detached');
      },
    };

    expect(isWebGL2Supported(mockMap)).toBe(false);
  });
});
