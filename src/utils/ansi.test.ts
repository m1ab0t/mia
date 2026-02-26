import { describe, it, expect } from 'vitest';
import { ansi, formatUptime, levelStyles, colorizeLine } from './ansi';

describe('ansi', () => {
  it('should export ANSI escape code constants', () => {
    expect(ansi.reset).toBe('\x1b[0m');
    expect(ansi.bold).toBe('\x1b[1m');
    expect(ansi.red).toBe('\x1b[31m');
    expect(ansi.green).toBe('\x1b[32m');
    expect(ansi.cyan).toBe('\x1b[36m');
  });

  it('should have consistent color values', () => {
    // Verify color codes don't change
    expect(ansi.yellow).toBe('\x1b[33m');
    expect(ansi.blue).toBe('\x1b[34m');
    expect(ansi.gray).toBe('\x1b[90m');
  });
});

describe('formatUptime', () => {
  it('should format seconds', () => {
    expect(formatUptime(5000)).toBe('5s');
    expect(formatUptime(45000)).toBe('45s');
  });

  it('should format minutes and seconds', () => {
    expect(formatUptime(60000)).toBe('1m 0s');
    expect(formatUptime(90000)).toBe('1m 30s');
    expect(formatUptime(3599000)).toBe('59m 59s');
  });

  it('should format hours and minutes', () => {
    expect(formatUptime(3600000)).toBe('1h 0m');
    expect(formatUptime(5400000)).toBe('1h 30m');
    expect(formatUptime(86340000)).toBe('23h 59m');
  });

  it('should format days, hours, and minutes', () => {
    expect(formatUptime(86400000)).toBe('1d 0h 0m');
    expect(formatUptime(90000000)).toBe('1d 1h 0m');
    expect(formatUptime(172800000)).toBe('2d 0h 0m');
  });
});

describe('levelStyles', () => {
  it('should export style config for each log level', () => {
    expect(levelStyles.INFO).toBeDefined();
    expect(levelStyles.WARN).toBeDefined();
    expect(levelStyles.ERROR).toBeDefined();
    expect(levelStyles.SUCCESS).toBeDefined();
    expect(levelStyles.DEBUG).toBeDefined();
  });

  it('should include badge, color, and icon for each level', () => {
    const style = levelStyles.INFO;
    expect(style.badge).toContain('INFO');
    expect(style.color).toBe(ansi.white);
    expect(style.icon).toBe('\u2139');
  });
});

describe('colorizeLine', () => {
  it('should colorize structured log format', () => {
    const line = '2025-01-15 10:30:45.123 [INFO  ] Starting daemon';
    const result = colorizeLine(line);

    expect(result).toContain('2025-01-15 10:30:45.123');
    expect(result).toContain('Starting daemon');
    expect(result).toContain(ansi.reset);
  });

  it('should handle ERROR level in structured format', () => {
    const line = '2025-01-15 10:30:45.123 [ERROR ] Connection failed';
    const result = colorizeLine(line);

    expect(result).toContain('Connection failed');
    expect(result).toContain(ansi.reset);
  });

  it('should colorize legacy daemon format', () => {
    const line = '[daemon] Processing message';
    const result = colorizeLine(line);

    expect(result).toContain('daemon');
    expect(result).toContain('Processing message');
    expect(result).toContain(ansi.reset);
  });

  it('should detect errors in legacy format', () => {
    const line = '[daemon] Error: Connection failed';
    const result = colorizeLine(line);

    expect(result).toContain(ansi.red);
    expect(result).toContain('\u2716'); // error icon
  });

  it('should detect success keywords in legacy format', () => {
    const line = '[daemon] Successfully started server';
    const result = colorizeLine(line);

    expect(result).toContain(ansi.green);
    expect(result).toContain('\u2714'); // success icon
  });

  it('should detect warning keywords in legacy format', () => {
    const line = '[daemon] Warning: Low memory';
    const result = colorizeLine(line);

    expect(result).toContain(ansi.yellow);
    expect(result).toContain('\u26a0'); // warning icon
  });

  it('should pass through unknown formats dimmed', () => {
    const line = 'Some random log line';
    const result = colorizeLine(line);

    expect(result).toContain(ansi.dim);
    expect(result).toContain('Some random log line');
    expect(result).toContain(ansi.reset);
  });

  it('should handle empty lines', () => {
    const result = colorizeLine('');
    expect(result).toContain(ansi.dim);
    expect(result).toContain(ansi.reset);
  });
});
