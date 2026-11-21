# HTTPS and installing the web UI as an app

The web UI is installable as an app — on a desktop browser, and on a phone's home
screen — but browsers only offer that on **HTTPS** or on `localhost`. On the machine
running the instance, `http://127.0.0.1:7650/app/` already qualifies. To open it from
any other device, put HTTPS in front of the webapi.

The app container publishes the webapi on `127.0.0.1:7650` only, so a proxy on the same
host is the whole job: it terminates TLS and forwards to that port. Nothing in the
instance changes.

> **There is no auth.** At Tier 1 the webapi trusts whoever can reach it — every
> transcript is readable, and `/api/ingest` accepts writes. Expose it only to devices
> you control: a private network (Option 1), or a proxy that adds auth (Option 2).

## Option 1: Tailscale Serve (private, least setup)

If your devices are on a [Tailscale](https://tailscale.com) tailnet, Tailscale issues a
real certificate for the machine's tailnet name and proxies to the local port. Nothing
is opened to the internet.

1. In the tailnet admin console, enable **MagicDNS** and **HTTPS Certificates**.
2. On the machine running the instance:

   ```sh
   tailscale serve --bg 7650
   ```

3. Open `https://<machine>.<tailnet>.ts.net/app/` from any device on the tailnet.

`tailscale serve status` shows what is being served; `tailscale serve --https=443 off`
stops it.

## Option 2: Caddy

[Caddy](https://caddyserver.com) obtains and renews certificates by itself.

**A public hostname** — DNS for the name points at this host, and ports 80 and 443
reach it:

```caddyfile
transcripts.example.net {
	basic_auth {
		# caddy hash-password
		you $2a$14$...
	}
	reverse_proxy 127.0.0.1:7650
}
```

Keep `basic_auth` on anything reachable from the internet. A hook on another machine
writing to this instance needs the same credentials: `webapi.auth` (`user:password`)
in its runtime config ([hook-setup.md](../start/hook-setup.md)), or `auth` on a mirror
([mirrors.md](mirrors.md)).

**LAN only** — no public DNS, so Caddy signs the certificate with its own local CA:

```caddyfile
transcripts.lan {
	tls internal
	reverse_proxy 127.0.0.1:7650
}
```

Each device then has to trust Caddy's root certificate (`caddy trust` prints where it
is). On a phone that is a manual install: on iOS, open the certificate as a profile,
then enable it under *Settings → General → About → Certificate Trust Settings*. If
that sounds like a chore, Option 1 avoids it.

Any other TLS-terminating proxy (nginx, Traefik, a Cloudflare Tunnel) works the same
way: forward everything to `127.0.0.1:7650`, unchanged paths.

## Installing the app

Open `https://<your host>/app/`, then:

| Where | How |
|---|---|
| Chrome, Edge (desktop) | the install icon at the right of the address bar, or *⋮ → Install* |
| Android (Chrome) | *⋮ → Add to home screen → Install* |
| iPhone, iPad (Safari) | *Share → Add to Home Screen* |

It opens in its own window, without browser chrome, under the project mark. It is the
same web UI reading the same instance: it needs the instance reachable to show
anything, and an upgrade to the instance is an upgrade to the app.

## Pointing hooks at the HTTPS address

A machine that records into this instance over the network uses the HTTPS URL as its
webapi:

```sh
claude-transcripts setup --webapi https://<your host>
```

See [hook-setup.md](../start/hook-setup.md).
