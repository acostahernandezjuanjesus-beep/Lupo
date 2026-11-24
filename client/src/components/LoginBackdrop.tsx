// A plain <img>, not inline: it's 15 KB of polygons that don't react to anything. The login is always dark, so
// it doesn't need to inherit CSS variables either.
export function LoginBackdrop() {
    return <img className="login__figure" src="/warehouse.svg" alt="" aria-hidden="true" />;
}
