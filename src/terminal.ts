export type ToolCallLogEvent = {
  client: string;
  tool: string;
  status: 'ok' | 'error';
  durationMs: number;
};

type LoggerOptions = {
  pretty: boolean;
  debug: boolean;
};

const stderr = process.stderr;
const colorEnabled = Boolean(stderr.isTTY) && !process.env.NO_COLOR;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function paint(value: string, code: keyof typeof ANSI) {
  if (!colorEnabled) return value;
  return `${ANSI[code]}${value}${ANSI.reset}`;
}

function timeLabel(date = new Date()) {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join(':');
}

function duration(ms: number) {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms / 1_000)}s`;
}

function fit(value: string, width: number) {
  const clean = value || 'unknown';
  if (clean.length <= width) return clean.padEnd(width, ' ');
  if (width <= 1) return clean.slice(0, width);
  return `${clean.slice(0, width - 1)}...`.slice(0, width);
}

function raw(message: string) {
  console.error(message);
}

export class TerminalLogger {
  constructor(private readonly options: LoggerOptions) {}

  status(scope: string, message: string) {
    if (!this.options.pretty) {
      raw(`${scope}: ${message}`);
      return;
    }
    raw(`${paint(timeLabel(), 'dim')}  ${paint(fit(scope, 10), 'cyan')} ${message}`);
  }

  warn(message: string) {
    if (!this.options.pretty) {
      raw(`Warning: ${message}`);
      return;
    }
    raw(`${paint(timeLabel(), 'dim')}  ${paint(fit('warn', 10), 'yellow')} ${message}`);
  }

  error(message: string, err?: unknown) {
    if (!this.options.pretty) {
      raw(err ? `${message} ${err instanceof Error ? err.stack ?? err.message : String(err)}` : message);
      return;
    }
    raw(`${paint(timeLabel(), 'dim')}  ${paint(fit('error', 10), 'red')} ${message}`);
    if (this.options.debug && err) {
      raw(err instanceof Error ? err.stack ?? err.message : String(err));
    }
  }

  debug(message: string) {
    if (!this.options.debug) return;
    if (!this.options.pretty) {
      raw(message);
      return;
    }
    raw(`${paint(timeLabel(), 'dim')}  ${paint(fit('debug', 10), 'dim')} ${message}`);
  }

  request(message: string) {
    if (!this.options.debug) return;
    if (!this.options.pretty) {
      raw(message);
      return;
    }
    raw(`${paint(timeLabel(), 'dim')}  ${paint(fit('request', 10), 'dim')} ${message}`);
  }

  tool(event: ToolCallLogEvent) {
    if (!this.options.pretty) {
      raw(`[mcp] ${new Date().toISOString()} client=${event.client} tools/call ${event.tool} ${event.status} ${duration(event.durationMs)}`);
      return;
    }

    const status =
      event.status === 'ok'
        ? paint(fit('ok', 6), 'green')
        : paint(fit('error', 6), 'red');
    raw(
      [
        paint(timeLabel(), 'dim'),
        fit(event.client, 24),
        paint(fit(event.tool, 24), 'cyan'),
        status,
        paint(duration(event.durationMs), 'dim'),
      ].join('  '),
    );
  }
}

export function createTerminalLogger() {
  return new TerminalLogger({
    pretty: process.env.LEARN_MCP_PRETTY_LOGS === '1',
    debug: process.env.LEARN_MCP_DEBUG === '1',
  });
}
