import { EventEmitter } from 'node:events';
import type { BrainEvent } from '../types.js';

/**
 * The signal that drives the UI.
 *
 * Because the MCP server runs inside the desktop app rather than as a spawned
 * subprocess, a tool call and the resulting highlight are the same tick - no
 * IPC, no polling, no sync layer.
 */
export class BrainEventBus extends EventEmitter {
  private readonly history: BrainEvent[] = [];
  private readonly maxHistory = 200;

  emitEvent(event: BrainEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.emit('brain', event);
  }

  recent(limit = 50): BrainEvent[] {
    return this.history.slice(-limit);
  }

  onEvent(listener: (e: BrainEvent) => void): () => void {
    this.on('brain', listener);
    return () => this.off('brain', listener);
  }
}
