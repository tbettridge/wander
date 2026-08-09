const PRIORITY_ORDER = Object.freeze(['high', 'normal', 'low']);

export class ContextPressureError extends Error {
  constructor(message = 'The prompt would leave too little model context for a response.') {
    super(message);
    this.name = 'ContextPressureError';
  }
}

export class BackgroundQueueOverflowError extends Error {
  constructor(message = 'The background AI queue is full.') {
    super(message);
    this.name = 'BackgroundQueueOverflowError';
  }
}

export class RuntimeCancelledError extends Error {
  constructor(message = 'The AI request was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

function priorityName(value) {
  return PRIORITY_ORDER.includes(value) ? value : 'normal';
}

function cancelledReason(code, message) {
  return Object.freeze({ code, message });
}

/**
 * Serializes every on-device inference operation. Chrome's model is shared
 * process-wide, so a small explicit scheduler is more predictable than
 * allowing dialogue and post-conversation memory work to contend implicitly.
 */
export class LivingWorldAIRuntime {
  constructor({
    onStatus = () => {},
    now = () => Date.now(),
    backgroundLimit = 16,
    failureThreshold = 3,
    failureWindowMs = 60000,
    cooldownMs = 30000,
  } = {}) {
    this.onStatus = onStatus;
    this.now = now;
    this.backgroundLimit = Math.max(1, Math.floor(backgroundLimit));
    this.failureThreshold = Math.max(1, Math.floor(failureThreshold));
    this.failureWindowMs = Math.max(1, Math.floor(failureWindowMs));
    this.cooldownMs = Math.max(1, Math.floor(cooldownMs));
    this.enabled = false;
    this.availability = 'disabled';
    this.activity = 'idle';
    this.progress = 0;
    this.lastErrorName = '';
    this.retryAt = 0;
    this.failures = [];
    this.queues = { high: [], normal: [], low: [] };
    this.current = null;
    this.running = false;
    this.sequence = 0;
    this.listeners = new Set();
    this.metrics = {
      enqueued: 0,
      completed: 0,
      failed: 0,
      preempted: 0,
      droppedBackground: 0,
      retries: 0,
      remounts: 0,
      reconnects: 0,
      timeouts: 0,
      contextCompactions: 0,
      contextOverflows: 0,
    };
  }

  get ready() {
    return this.enabled && this.availability === 'ready' && !this.isCoolingDown();
  }

  queueDepth() {
    return PRIORITY_ORDER.reduce((total, priority) => total + this.queues[priority].length, 0);
  }

  snapshot() {
    const state = this.availability === 'ready'
      ? (this.activity === 'idle' ? 'ready' : this.activity)
      : this.availability;
    return {
      state,
      availability: this.availability,
      activity: this.activity,
      progress: this.progress,
      queueDepth: this.queueDepth(),
      activeTask: this.current?.kind || '',
      lastErrorName: this.lastErrorName,
      retryAt: this.retryAt || null,
      metrics: { ...this.metrics },
    };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  emit(extra = {}) {
    const snapshot = { ...this.snapshot(), ...extra };
    try { this.onStatus(snapshot); } catch { /* diagnostics must never break inference */ }
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* isolate optional observers */ }
    }
    return snapshot;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) {
      this.availability = 'disabled';
      this.activity = 'idle';
      this.progress = 0;
      this.retryAt = 0;
      this.failures = [];
      this.cancelWhere(() => true, cancelledReason('disabled', 'On-device AI was disabled.'));
    } else if (this.availability === 'disabled') {
      this.availability = 'probing';
    }
    this.emit();
  }

  setAvailability(availability, extra = {}) {
    this.availability = availability;
    if (Number.isFinite(extra.progress)) this.progress = extra.progress;
    if (extra.message) this.lastErrorName = extra.errorName || this.lastErrorName;
    this.emit(extra);
  }

  setActivity(activity) {
    this.activity = activity || 'idle';
    this.emit();
  }

  markRetry() {
    this.metrics.retries++;
    this.emit();
  }

  markMetric(name, amount = 1) {
    if (Object.hasOwn(this.metrics, name)) this.metrics[name] += amount;
    this.emit();
  }

  isCoolingDown() {
    if (!this.retryAt) return false;
    if (this.now() < this.retryAt) return true;
    this.retryAt = 0;
    this.failures = [];
    if (this.enabled && this.availability === 'cooldown') this.availability = 'probing';
    return false;
  }

  recordFailure(error, { context = false, cancelled = false } = {}) {
    const name = error?.name || 'Error';
    this.lastErrorName = name;
    if (context || cancelled) {
      this.emit();
      return false;
    }
    if (name === 'AbortError') this.metrics.timeouts++;
    const cutoff = this.now() - this.failureWindowMs;
    this.failures = this.failures.filter((timestamp) => timestamp >= cutoff);
    this.failures.push(this.now());
    if (this.failures.length >= this.failureThreshold) {
      this.retryAt = this.now() + this.cooldownMs;
      this.availability = 'cooldown';
      this.emit();
      return true;
    }
    this.emit();
    return false;
  }

  clearFailures() {
    this.failures = [];
    this.retryAt = 0;
    this.lastErrorName = '';
  }

  enqueue({
    priority = 'normal',
    kind = 'inference',
    activity = 'generating',
    conversationId = null,
    background = false,
    run,
  }) {
    if (typeof run !== 'function') return Promise.reject(new TypeError('AI queue jobs require run().'));
    if (!this.enabled) return Promise.reject(new RuntimeCancelledError('On-device AI is disabled.'));
    const normalizedPriority = priorityName(priority);
    if (background && normalizedPriority === 'low') {
      const pendingBackground = this.queues.low.filter((job) => job.background).length
        + (this.current?.background ? 1 : 0);
      if (pendingBackground >= this.backgroundLimit) {
        this.metrics.droppedBackground++;
        this.emit();
        return Promise.reject(new BackgroundQueueOverflowError());
      }
    }

    let resolveJob;
    let rejectJob;
    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job = {
      id: ++this.sequence,
      priority: normalizedPriority,
      kind,
      activity,
      conversationId,
      background,
      run,
      resolve: resolveJob,
      reject: rejectJob,
      controller: null,
      preemptions: 0,
    };
    this.queues[normalizedPriority].push(job);
    this.metrics.enqueued++;
    if (normalizedPriority === 'high' && this.current?.priority === 'low') {
      this.current.controller?.abort(cancelledReason(
        'foreground-preemption', 'Background AI yielded to player dialogue.',
      ));
    }
    if (this.running) {
      this.emit();
    } else {
      this.activity = 'queued';
      this.emit();
      queueMicrotask(() => this.drain());
    }
    return promise;
  }

  nextJob() {
    for (const priority of PRIORITY_ORDER) {
      const job = this.queues[priority].shift();
      if (job) return job;
    }
    return null;
  }

  async drain() {
    if (this.running) return;
    const job = this.nextJob();
    if (!job) {
      this.activity = 'idle';
      this.emit();
      return;
    }
    this.running = true;
    this.current = job;
    job.controller = new AbortController();
    this.activity = job.activity;
    this.emit();
    let requeued = false;
    try {
      const result = await job.run({ signal: job.controller.signal, job });
      this.metrics.completed++;
      job.resolve(result);
    } catch (error) {
      const reason = job.controller.signal.reason;
      if (reason?.code === 'foreground-preemption' && job.background && job.preemptions < 1
        && this.enabled) {
        job.preemptions++;
        this.metrics.preempted++;
        this.queues.low.push(job);
        requeued = true;
      } else {
        this.metrics.failed++;
        job.reject(error);
      }
    } finally {
      this.current = null;
      this.running = false;
      this.activity = this.queueDepth() ? 'queued' : 'idle';
      this.emit({ requeued });
      if (this.queueDepth()) queueMicrotask(() => this.drain());
    }
  }

  cancelWhere(predicate, reason = cancelledReason('cancelled', 'AI request cancelled.')) {
    for (const priority of PRIORITY_ORDER) {
      const retained = [];
      for (const job of this.queues[priority]) {
        if (predicate(job)) job.reject(new RuntimeCancelledError(reason.message));
        else retained.push(job);
      }
      this.queues[priority] = retained;
    }
    if (this.current && predicate(this.current)) this.current.controller?.abort(reason);
  }

  cancelConversation(conversationId) {
    if (!conversationId) return;
    this.cancelWhere((job) => job.conversationId === conversationId,
      cancelledReason('conversation-discarded', 'The conversation was discarded.'));
  }
}
