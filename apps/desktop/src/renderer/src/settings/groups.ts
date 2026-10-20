import {
  Captions,
  Heart,
  Keyboard,
  MonitorPlay,
  Play,
  SlidersHorizontal,
  Video,
  Volume2,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import type { GroupId } from './registry';

export interface GroupMeta {
  id: Exclude<GroupId, 'internal'>;
  title: string;
  icon: LucideIcon;
  /** Kenar çubuğundaki simge karesinin rengi (macOS Ayarlar gibi) */
  tint: string;
}

export const GROUPS: GroupMeta[] = [
  { id: 'general', title: 'Genel', icon: SlidersHorizontal, tint: '#8e8e93' },
  { id: 'playback', title: 'Oynatma', icon: Play, tint: '#ff375f' },
  { id: 'video', title: 'Görüntü', icon: MonitorPlay, tint: '#0a84ff' },
  { id: 'audio', title: 'Ses', icon: Volume2, tint: '#ff9f0a' },
  { id: 'camera', title: 'Kamera', icon: Video, tint: '#30d158' },
  { id: 'subtitles', title: 'Altyazı', icon: Captions, tint: '#e5b800' },
  { id: 'connection', title: 'Bağlantı', icon: Wifi, tint: '#5ac8fa' },
  { id: 'shortcuts', title: 'Kısayollar', icon: Keyboard, tint: '#bf5af2' },
  { id: 'pairing', title: 'Eşleşme', icon: Heart, tint: '#ff2d55' },
];
