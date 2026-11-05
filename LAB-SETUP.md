# Lab setup — sole operator

## Local account (no OAuth)

With `VITE_DEV_AUTO_LOGIN=true` (baked into frontend build), opening the lab signs you in as:

| Field | Value |
|-------|--------|
| Username | `admin` |
| Password | `lab-local-only-not-prod` |

Hard-refresh the browser (or clear site data for localhost:8797) if an old login page is cached.

This is a **local workshop account**, not Cloudflared and not Command Station.

## Run

```bash
cd ~/projects/cloudflare-os-lab
VITE_BACKEND_HOST=localhost:8797 pnpm run-local
# → http://localhost:8797
```

`:8787` may be gov-intel keys UI — leave it.

## Gatekeeper OAuth (GitHub + Cloudflare)

### 1) GitHub OAuth App

1. https://github.com/settings/developers → **OAuth Apps** → New  
2. **Application name:** `CF OS Lab Local`  
3. **Homepage URL:** `http://localhost:8797`  
4. **Authorization callback URL:** `http://localhost:8797/gatekeeper/github/oauth`  
5. Register → Generate client secret  

### 2) Cloudflare OAuth client

1. Create a **dashboard OAuth client** in Cloudflare (account OAuth / API applications used by CF OS gatekeeper — see package README).  
2. Register redirect: `http://localhost:8797/gatekeeper/cloudflare/oauth`  

### 3) Enter secrets (keyway — never paste into chat)

```bash
cd ~/projects/cloudflare-os-lab
keyway
# open http://127.0.0.1:8790 → Validate & save
keyway status
```

Then restart `pnpm run-local`.

`AUTH_GATEKEEPERS=github,cloudflare` is already in `.dev.vars`.

## Side deploy later

See `~/projects/The_Sentient_Spear/labs/cloudflare-os/SIDE-DEPLOY.md`  
Use **separate** OAuth apps with callbacks on `https://lab.proventialatlas.com/gatekeeper/...`
