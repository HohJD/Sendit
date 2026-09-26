import { instagram } from './instagram.ts';
import { wassist } from './wassist.ts';
import { whatsapp } from './whatsapp.ts';
import type { ChannelAdapter, ChannelName } from './types.ts';

export type { Button, ChannelAdapter, ChannelName, InboundMessage } from './types.ts';

export const channels: Record<ChannelName, ChannelAdapter> = {
  whatsapp,
  wassist,
  instagram,
};

export function getChannel(name: string): ChannelAdapter {
  const channel = channels[name as ChannelName];
  if (!channel) throw new Error(`unknown channel: ${name}`);
  return channel;
}

export function channelForPath(pathname: string): ChannelAdapter | undefined {
  return Object.values(channels).find((c) => c.webhookPath === pathname);
}
