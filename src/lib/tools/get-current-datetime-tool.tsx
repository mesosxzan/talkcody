import { z } from 'zod';
import { createTool } from '@/lib/create-tool';
import { logger } from '@/lib/logger';

export interface GetCurrentDateTimeResult {
  success: boolean;
  utc: string;
  local: string;
  date: string;
  time: string;
  timestamp: number;
  timezone_offset: string;
  timezone_name: string;
  day_of_week: string;
  week_number: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  error?: string;
}

export const getCurrentDateTimeTool = createTool({
  name: 'getCurrentDateTime',
  description: `Get the current date and time in various formats. Returns ISO 8601 formatted strings, Unix timestamp, timezone information, and date/time components.

This tool provides comprehensive date and time information including:
- UTC and local time in ISO 8601 format
- Separate date and time components
- Unix timestamp
- Timezone offset and name
- Day of week and week number
- Individual date/time components (year, month, day, hour, minute, second)

Use this tool when you need to know the current date or time for any purpose, such as:
- Logging timestamps
- Scheduling tasks
- Date/time calculations
- Understanding the current context`,
  inputSchema: z.object({}),
  canConcurrent: true,
  execute: async (_input, context): Promise<GetCurrentDateTimeResult> => {
    logger.info('Getting current date and time', {
      taskId: context.taskId,
    });

    try {
      const now = new Date();

      // Get timezone information
      const timezoneOffset = -now.getTimezoneOffset();
      const offsetHours = Math.floor(Math.abs(timezoneOffset) / 60);
      const offsetMinutes = Math.abs(timezoneOffset) % 60;
      const offsetSign = timezoneOffset >= 0 ? '+' : '-';
      const timezoneOffsetStr = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;

      // Get timezone name
      const timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // Get day of week
      const daysOfWeek = [
        'Sunday',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
      ];
      const dayOfWeek = daysOfWeek[now.getDay()];

      // Get week number
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      const days = Math.floor((now.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
      const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);

      // Format ISO strings
      const utc = now.toISOString();
      const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString();
      const local = localIso.slice(0, -1) + timezoneOffsetStr;

      const dateStr = now.toISOString().split('T')[0];
      const timeStr = now.toTimeString().split(' ')[0];

      return {
        success: true,
        utc,
        local,
        date: dateStr || '',
        time: timeStr || '',
        timestamp: Math.floor(now.getTime() / 1000),
        timezone_offset: timezoneOffsetStr,
        timezone_name: timezoneName || '',
        day_of_week: dayOfWeek || '',
        week_number: weekNumber,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        hour: now.getHours(),
        minute: now.getMinutes(),
        second: now.getSeconds(),
      };
    } catch (error) {
      logger.error('Failed to get current date and time', error);
      return {
        success: false,
        utc: '',
        local: '',
        date: '',
        time: '',
        timestamp: 0,
        timezone_offset: '',
        timezone_name: '',
        day_of_week: '',
        week_number: 0,
        year: 0,
        month: 0,
        day: 0,
        hour: 0,
        minute: 0,
        second: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
  renderToolDoing: () => null,
  renderToolResult: (result) => {
    if (!result.success) {
      return (
        <div className="text-red-500">
          Error: {result.error || 'Failed to get current date and time'}
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="font-semibold">UTC:</span> {result.utc}
          </div>
          <div>
            <span className="font-semibold">Local:</span> {result.local}
          </div>
          <div>
            <span className="font-semibold">Date:</span> {result.date}
          </div>
          <div>
            <span className="font-semibold">Time:</span> {result.time}
          </div>
          <div>
            <span className="font-semibold">Timezone:</span> {result.timezone_name} (
            {result.timezone_offset})
          </div>
          <div>
            <span className="font-semibold">Day:</span> {result.day_of_week}
          </div>
          <div>
            <span className="font-semibold">Week:</span> {result.week_number}
          </div>
          <div>
            <span className="font-semibold">Timestamp:</span> {result.timestamp}
          </div>
        </div>
      </div>
    );
  },
});
