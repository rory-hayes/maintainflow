import {triggerMonitor, type TriggerEnvironment} from '../../scripts/monitor-external-trigger.ts';

export default {
  async scheduled(controller: {scheduledTime: number}, env: TriggerEnvironment): Promise<void> {
    const result = await triggerMonitor(controller.scheduledTime, env);
    console.log(JSON.stringify(result));
    // Mark provider invocation failure; never turn a dispatch failure into a success ping.
    if (result.status === 'failed') throw new Error('monitor_trigger_failed');
  },
};
