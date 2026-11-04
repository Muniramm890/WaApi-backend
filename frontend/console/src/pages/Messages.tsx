import { MessagesPanel } from '../components/MessagesPanel';
import { PageHeader } from '../components/ui';

export default function Messages() {
  return (<><PageHeader title="Messages" sub="Every inbound and outbound WhatsApp message across the platform. Tap a row for full details." /><MessagesPanel /></>);
}
