/**
 * # photo-to-slack
 * Take a camera photo and post it to a Slack channel. Demonstrates that Slack is
 * a SELF action for a task — no station capability, no round-trip: the base class
 * exposes `this.sendPhotoToSlack(...)` directly. Only the PHOTO PIXELS come from
 * the station (`this.frame()`, a real capability — the live camera state).
 *
 * Reference for an LLM authoring its own "send a photo to slack" task.
 */
import { Task, runTask, type TaskManifest } from '../../_harness/index.js';

export const manifest = {
  name: 'photo-to-slack',
  description: 'Take a camera photo now and post it to Slack. Use for "send a photo to slack / snap a pic to #channel".',
  params: [
    { name: 'channel', type: 'string', required: false },   // omit → SLACK_DEFAULT_CHANNEL
    { name: 'caption', type: 'string', required: false },
  ],
} satisfies TaskManifest;

class PhotoToSlackTask extends Task {
  async run(): Promise<void> {
    const channel = (this.params.channel as string | undefined) || undefined;
    const caption = (this.params.caption as string | undefined) || undefined;
    this.status('taking a photo and sending it to Slack');
    // sendPhotoToSlack grabs the current frame itself; throws if the camera is down.
    await this.sendPhotoToSlack({ channel, caption });
    await this.notifyAgent(`Sent a photo to ${channel ?? 'Slack'}.`);
    this.finish('photo sent to Slack');
  }

  getStatus(): string {
    return 'take a photo → post it to Slack';
  }
}

runTask(PhotoToSlackTask);
