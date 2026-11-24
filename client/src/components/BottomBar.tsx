import { Link } from 'react-router';
import { Menu } from '@carbon/icons-react';
import type { ComponentType } from 'react';

// Daily-use links within thumb reach (phone only, see `.bottom-bar` in index.scss). Everything else stays in the menu: "More" opens it.

export type Shortcut = { path: string; title: string; icon: ComponentType<{ size?: number }>; badge?: number };

export function BottomBar({ shortcuts, pathname, onMore }: { shortcuts: Shortcut[]; pathname: string; onMore: () => void }) {
    return <nav className="bottom-bar" aria-label="Shortcuts">
        {shortcuts.map(a => {
            const Icon = a.icon;
            const active = pathname === a.path;
            return <Link key={a.path} to={a.path} className="bottom-bar__item" aria-current={active ? 'page' : undefined}>
                <span className="bottom-bar__icon">
                    <Icon size={24} />
                    {!!a.badge && <span className="bottom-bar__badge" aria-label={`${a.badge} open`}>{a.badge}</span>}
                </span>
                {a.title}
            </Link>;
        })}
        <button type="button" className="bottom-bar__item" onClick={onMore}>
            <span className="bottom-bar__icon"><Menu size={24} /></span>
            More
        </button>
    </nav>;
}
