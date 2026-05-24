import { describe, it, expect } from 'bun:test';
import { getCurrentDateTimeTool } from './get-current-datetime-tool';

describe('getCurrentDateTimeTool', () => {
  it('should return current date and time', async () => {
    const result = await getCurrentDateTimeTool.execute({}, {
      taskId: 'test-task',
      toolId: 'test-tool',
      rootPath: '/tmp',
    });

    expect(result.success).toBe(true);
    expect(result.utc).toBeDefined();
    expect(result.local).toBeDefined();
    expect(result.date).toBeDefined();
    expect(result.time).toBeDefined();
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.year).toBeGreaterThanOrEqual(2024);
    expect(result.month).toBeGreaterThanOrEqual(1);
    expect(result.month).toBeLessThanOrEqual(12);
    expect(result.day).toBeGreaterThanOrEqual(1);
    expect(result.day).toBeLessThanOrEqual(31);
    expect(result.hour).toBeGreaterThanOrEqual(0);
    expect(result.hour).toBeLessThanOrEqual(23);
    expect(result.minute).toBeGreaterThanOrEqual(0);
    expect(result.minute).toBeLessThanOrEqual(59);
    expect(result.second).toBeGreaterThanOrEqual(0);
    expect(result.second).toBeLessThanOrEqual(59);
  });

  it('should return valid ISO 8601 format', async () => {
    const result = await getCurrentDateTimeTool.execute({}, {
      taskId: 'test-task',
      toolId: 'test-tool',
      rootPath: '/tmp',
    });

    // Check UTC format
    expect(result.utc).toContain('T');
    expect(result.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // Check local format
    expect(result.local).toContain('T');

    // Check date format YYYY-MM-DD
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Check time format HH:MM:SS
    expect(result.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('should return timezone information', async () => {
    const result = await getCurrentDateTimeTool.execute({}, {
      taskId: 'test-task',
      toolId: 'test-tool',
      rootPath: '/tmp',
    });

    expect(result.timezone_offset).toBeDefined();
    expect(result.timezone_name).toBeDefined();
    expect(result.day_of_week).toBeDefined();
    expect(result.week_number).toBeGreaterThanOrEqual(1);
    expect(result.week_number).toBeLessThanOrEqual(53);
  });
});
