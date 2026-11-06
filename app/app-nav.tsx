import Link from 'next/link';
import { Briefcase, Send, UserRound } from 'lucide-react';

const destinations = [
  ['Jobs', '/', Briefcase],
  ['Auto Apply', '/applications', Send],
  ['Profile', '/profile', UserRound],
] as const;

/** Postie's sidebar tabs: icon and name, the current one on the selected fill. */
export function AppNav({ current }: { current: string }) {
  return (
    <nav aria-label="Primary navigation" className="side-nav">
      {destinations.map(([label, href, Icon]) => (
        <Link
          key={href}
          href={href}
          prefetch={false}
          className="tab"
          title={label}
          aria-label={label} // the name survives the rail, where the text is hidden
          aria-current={current === href ? 'page' : undefined}
        >
          <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="tab-name">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
