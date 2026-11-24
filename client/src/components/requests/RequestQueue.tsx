import { Button, InlineLoading, InlineNotification } from '@carbon/react';
import { Notification as AlertIcon, NotificationOff } from '@carbon/icons-react';
import { errorMessage } from '../../queries';
import { isOpen, useChangeRequest, useRequests, type MaterialRequest } from '../../requests';
import { usePhoneAlerts, type PushState } from '../../push';
import { RequestCard } from './RequestMaterial';

const CARD = 'rounded-2xl bg-layer p-4 md:p-5 min-w-0';

/**
 * What the floor is asking for, from the storeroom's side: oldest first, with where each piece
 * is, so it can be gathered while the person walks over. "Gathered" notifies whoever asked;
 * "Delivered" closes it. A request subtracts no stock: the stock-out is recorded on delivery.
 */
export function RequestQueue({ empty = false }: { empty?: boolean }) {
    const query = useRequests();
    const change = useChangeRequest();

    const all = query.data?.requests ?? [];
    const open = all.filter(isOpen).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const closed = all.filter(p => !isOpen(p)).slice(0, 5);
    // With no requests and not asked for (the Home screen), the card takes no space.
    if (!empty && open.length === 0 && !query.error) return null;

    const buttons = (p: MaterialRequest) => <>
        {p.status === 'pending' && <Button size="sm" kind="primary" disabled={change.isPending} onClick={() => change.mutate({ id: p.id, status: 'ready' })}>Gathered</Button>}
        <Button size="sm" kind={p.status === 'ready' ? 'primary' : 'tertiary'} disabled={change.isPending} onClick={() => change.mutate({ id: p.id, status: 'delivered' })}>Delivered</Button>
        <Button size="sm" kind="ghost" disabled={change.isPending} onClick={() => change.mutate({ id: p.id, status: 'cancelled' })}>Don't deliver</Button>
    </>;

    return <article className={CARD + ' flex flex-col gap-3'} aria-label="Floor requests">
        <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="text-base">Floor requests{open.length > 0 && ` (${open.length})`}</h2>
            <PhoneAlerts />
        </div>
        {query.isPending && <InlineLoading description="Loading…" />}
        {query.error && <InlineNotification kind="error" title="Could not load the requests" subtitle={errorMessage(query.error)} hideCloseButton />}
        {change.error && <InlineNotification kind="error" title="Could not change the request" subtitle={errorMessage(change.error)} hideCloseButton />}
        {query.data && open.length === 0 && <p className="muted">No open requests.</p>}
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {open.map(p => <RequestCard key={p.id} request={p} showRequester action={buttons(p)} />)}
        </ul>
        {empty && closed.length > 0 && <>
            <h3 className="mt-2 text-sm text-text-2">Closed today</h3>
            <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">{closed.map(p => <RequestCard key={p.id} request={p} showRequester />)}</ul>
        </>}
    </article>;
}

const MESSAGE: Partial<Record<PushState, string>> = {
    unsupported: 'This browser can\'t receive alerts while the page is closed.',
    install: 'On iPhone: tap Share, "Add to Home Screen", and open Lupo from there. Then you can turn on alerts.',
    blocked: 'You blocked alerts for this site. They can be turned back on in the browser settings.',
};

/** Turn the phone alert (Web Push) on or off on THIS device. */
function PhoneAlerts() {
    const { state, error, enable, disable } = usePhoneAlerts();
    if (state === 'loading') return null;
    return <div className="flex max-w-sm flex-col items-start gap-1">
        {state === 'inactive' && <Button kind="tertiary" size="sm" renderIcon={AlertIcon} onClick={() => void enable()}>Turn on alerts on this device</Button>}
        {state === 'active' && <Button kind="ghost" size="sm" renderIcon={NotificationOff} onClick={() => void disable()}>Alerts on · turn off</Button>}
        {MESSAGE[state] && <p className="muted">{MESSAGE[state]}</p>}
        {error && <InlineNotification kind="error" title="Could not turn on" subtitle={error} hideCloseButton />}
    </div>;
}
