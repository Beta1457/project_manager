# Using the Project Manager away from home

The Project Manager speaks plain HTTP and is built for your own network. To use it from a laptop or phone while you're out, connect those devices to the server through a **VPN that ends on the server itself**. Set up as below, the devices can reach the Project Manager and nothing else: not your other computers, and not other services on the server.

Two ways to do it:

- **[Option A: WireGuard on the server](#option-a-wireguard-on-the-server).** Fully self-hosted. You forward one UDP port on your router.
- **[Option B: Tailscale](#option-b-tailscale).** No router changes, and it works even when your internet provider doesn't give you a public address. Needs a free Tailscale account.

## Don't forward the app's port

Forwarding the Project Manager's port on your router, even an unusual one, would:

- put its login page in front of the whole internet. Bots scan every port, not just the common ones.
- send your password, session cookie and API tokens unencrypted across every network in between, hotel Wi-Fi included.
- make any future bug in the app reachable from anywhere.

A WireGuard port is different: WireGuard ignores every packet that isn't signed with one of your devices' keys, so to everyone else it looks closed.

Also leave your router's built-in **VPN server** feature off, if it has one. Those usually put connected devices on your whole home network, which is what this guide avoids.

**HTTPS isn't needed here.** The VPN encrypts everything between your device and the server, and the tunnel ends on the server itself, so the plain-HTTP traffic never crosses a network unprotected.

## Which option?

| | WireGuard on the server | Tailscale |
|---|---|---|
| Router changes | Forward one UDP port | None |
| Works when your provider uses CGNAT (no public IPv4 address) | No | Yes |
| Accounts and third parties | None | A Tailscale account; their servers only coordinate, your traffic is end-to-end encrypted |
| Same address at home and away | Only if your router supports NAT loopback | Yes |

Before either option: the server must accept connections from other devices. That's the "Let phones and other computers on your network connect?" question in `npm run setup` (`PM_HOST=0.0.0.0` in `.env`).

## Option A: WireGuard on the server

The server listens on one UDP port. Your laptop and phone connect to it, and reach the Project Manager at the server's tunnel address, `http://10.47.0.1:8080`. The examples use:

| | Example | Yours |
|---|---|---|
| Tunnel addresses | server `10.47.0.1`, laptop `10.47.0.2`, phone `10.47.0.3` (subnet `10.47.0.0/24`) | Any private range your other networks don't use |
| WireGuard port | `51820` (UDP) | Any free UDP port. A different number doesn't add security, since WireGuard stays silent either way. |
| Project Manager port | `8080` | The port you chose in setup |
| Server's home network address | `192.168.1.10` | Shown by `ipconfig` on the server |
| Home address name | `yourname.mynetgear.com` | From step 3 |

The server steps below are for Windows, where the Project Manager's firewall script helps. On a Mac or Linux server the WireGuard configuration is the same, and the firewall rules are yours to write.

### 1. Check that your internet connection can accept connections

Your router's status page shows its **Internet (WAN) IP address**. Compare it with what [ifconfig.me](https://ifconfig.me) shows from any device at home.

- **The same:** good, carry on.
- **The router's WAN address starts with 100.64 to 100.127:** your provider shares one public address between many customers (CGNAT), so nothing can connect in. Use [Option B](#option-b-tailscale), or ask your provider for a public IPv4 address.
- **The router's WAN address is private (10.x, 172.16 to 172.31, or 192.168.x) and ifconfig.me shows something else:** there's a second router in front of yours, often the provider's modem. Put the modem in bridge mode, or forward the port on both.

### 2. Give the server a fixed address on your network

In your router, reserve an address for the server so it doesn't change and break the port forward. Look for **Address Reservation** or **DHCP reservation**; on NETGEAR routers it's under Advanced → Setup → LAN Setup. Menu names vary between routers and firmware versions.

### 3. Get a name for your home address (Dynamic DNS)

Your home's public address can change, so give it a name that follows it. Most routers can keep one updated for you.

- On NETGEAR routers: Advanced → Advanced Setup → Dynamic DNS, with NETGEAR as the provider, gives a free `yourname.mynetgear.com` name (run by No-IP). Free No-IP names must be confirmed by email every 30 days or they're deleted.
- Other providers: DuckDNS, No-IP, Cloudflare, or whatever your router supports.

### 4. Create the server's tunnel

1. Install WireGuard for Windows from [wireguard.com/install](https://www.wireguard.com/install/).
2. Open it and choose **Add Tunnel ▾ → Add empty tunnel…**. Name it `pm`. The app generates the server's key pair: the `PrivateKey` line in the editor stays on the server, and the **public key** shown above it is what the devices need. Public keys aren't secret.
3. Below the generated `PrivateKey` line, add the port and the server's tunnel address, then save:

   ```ini
   [Interface]
   PrivateKey = (generated by the app, keep it)
   ListenPort = 51820
   Address = 10.47.0.1/24
   ```

You'll add the laptop and phone in step 6.

### 5. Create a tunnel on the laptop and the phone

Each device makes its own key pair. Private keys never leave the device they were made on. Public keys aren't secret, so emailing or messaging them to yourself is fine.

**Laptop (Windows or macOS):** install WireGuard from [wireguard.com/install](https://www.wireguard.com/install/) (the Mac App Store on macOS). Choose **Add empty tunnel…**, note the laptop's **public key** shown at the top, and complete the configuration:

```ini
[Interface]
PrivateKey = (generated on the laptop, keep it)
Address = 10.47.0.2/32

[Peer]
PublicKey = (the server's public key from step 4)
Endpoint = yourname.mynetgear.com:51820
AllowedIPs = 10.47.0.1/32
```

`AllowedIPs = 10.47.0.1/32` sends only traffic for the server through the tunnel. Everything else, like browsing and email, uses your normal connection.

**Laptop (Linux):** install `wireguard-tools`, make keys with `wg genkey | tee laptop.key | wg pubkey > laptop.pub`, put the configuration above in `/etc/wireguard/pm.conf` (with the contents of `laptop.key` as the `PrivateKey`), and connect with `sudo wg-quick up pm`.

**Phone:** install the WireGuard app (App Store or Google Play). Tap **+ → Create from scratch**, name it, and tap **Generate keypair**; note the phone's **public key**. Set **Addresses** to `10.47.0.3/32`. Add a peer with the server's public key, **Endpoint** `yourname.mynetgear.com:51820` and **Allowed IPs** `10.47.0.1/32`, then save.

### 6. Add the devices to the server's tunnel

Back on the server, edit the `pm` tunnel and add one `[Peer]` block per device, below the `[Interface]` lines:

```ini
[Peer]
# laptop
PublicKey = (the laptop's public key)
AllowedIPs = 10.47.0.2/32

[Peer]
# phone
PublicKey = (the phone's public key)
AllowedIPs = 10.47.0.3/32
```

Save, then click **Activate**. An activated tunnel runs as a Windows service and comes back after a reboot.

Many WireGuard server guides also turn on IP routing or NAT (`New-NetNat`, `IPEnableRouter`). **Skip that:** it's what would put your devices on your whole home network. Without it they can only reach the server.

### 7. Set up the server's firewall

In an **Administrator** PowerShell, in the Project Manager folder:

```powershell
New-NetFirewallRule -DisplayName "WireGuard (UDP 51820)" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 51820 -Profile Any
```

```powershell
.\scripts\open-firewall.ps1 -VpnSubnet 10.47.0.0/24
```

- The first rule lets WireGuard's packets in. WireGuard only answers devices whose keys you added.
- The script lets devices on the tunnel reach the Project Manager. It also blocks **every other port** for them, so Remote Desktop, file sharing, game servers or anything else on the server stays out of reach through the tunnel, whatever other firewall rules allow.

Check the result with `Get-NetFirewallRule -DisplayName "Project Manager*" | Format-Table DisplayName, Action, Enabled`. If you change the Project Manager's port later, run the script again with the same `-VpnSubnet`.

### 8. Forward the WireGuard port on your router

Forward **UDP** port `51820` to the server's address (`192.168.1.10`). On NETGEAR routers: Advanced → Advanced Setup → Port Forwarding / Port Triggering → **Add Custom Service**. Choose **UDP**, enter `51820` as both the external and internal port, and the server's address as the internal IP.

Forward only this one UDP port. Nothing for the Project Manager's port.

### 9. Test it

1. On the phone, **turn Wi-Fi off** so it uses mobile data, and switch the tunnel on.
2. Open `http://10.47.0.1:8080`.
3. The WireGuard apps show a **latest handshake** time once the phone and the server have connected.

From your home Wi-Fi the tunnel only connects if your router supports **NAT loopback** (most do). If it does, you can leave the tunnel on all the time and use one address everywhere. If it doesn't, switch the tunnel off at home and use the server's home address there.

On iPhone, **Edit → On-Demand Activation** can switch the tunnel on by itself, for example on mobile data and on Wi-Fi other than yours.

**No handshake?** Check, in order:

- CGNAT (step 1).
- The port forward: it must be **UDP**, to the right address.
- That your home address name points at your current address (compare `nslookup yourname.mynetgear.com` with ifconfig.me).
- The `WireGuard (UDP 51820)` firewall rule on the server.
- The keys: each side needs the *other* side's public key.

**Handshake, but the page doesn't load?** Check that `open-firewall.ps1` ran with `-VpnSubnet`, and that the server accepts connections from other devices (`PM_HOST=0.0.0.0` in `.env`).

### Your coding agent on the laptop

Point the laptop's integration (Claude Code or another agent) at the tunnel address. With the tunnel connected, re-run the installer in your code project, downloading it through the tunnel so it defaults to that address. It keeps your token and project.

macOS / Linux:

```bash
curl -fsSL http://10.47.0.1:8080/integration/install.mjs -o /tmp/pm-install.mjs && node /tmp/pm-install.mjs
```

Windows (PowerShell):

```powershell
irm http://10.47.0.1:8080/integration/install.mjs -OutFile $env:TEMP\pm-install.mjs; node $env:TEMP\pm-install.mjs
```

This works at home too as long as the tunnel connects there (NAT loopback, above). If your router doesn't support that, Tailscale avoids the problem.

### Lost a device?

On the server, delete its `[Peer]` block from the tunnel and save. Also revoke its API token in **Settings → API tokens** if it had one.

## Option B: Tailscale

[Tailscale](https://tailscale.com) builds the same kind of WireGuard tunnel for you, and gets through routers and CGNAT without any port forwarding.

1. **Install Tailscale** on the server, the laptop and the phone ([tailscale.com/download](https://tailscale.com/download)), and sign in with the same account on each.
2. **Keep the server connected.** On a Windows server, turn on **Run unattended** in Tailscale's menu (under Preferences) so it stays connected when nobody is signed in to Windows. In the Tailscale admin console, open the server's **⋯** menu on the Machines page and choose **Disable key expiry**, so it doesn't drop off the network after a few months.
3. **Find the server's Tailscale address**, `100.x.y.z`. It's in Tailscale's menu on the server, or run `tailscale ip -4` there.
4. **Allow it through the server's firewall** (Windows, Administrator PowerShell, in the Project Manager folder). Tailscale addresses are in `100.64.0.0/10`:

   ```powershell
   .\scripts\open-firewall.ps1 -VpnSubnet 100.64.0.0/10
   ```

   As with WireGuard, this also blocks every other port on the server for Tailscale devices.
5. **Limit your devices to the Project Manager.** By default, every device on your Tailscale network can reach every port on every other device. In the admin console, open **Access controls** and replace the default rules with a single grant, using the server's address from step 3 and your Project Manager port:

   ```json
   {
     "grants": [
       { "src": ["autogroup:member"], "dst": ["100.101.102.103"], "ip": ["tcp:8080"] }
     ]
   }
   ```

   If you use Tailscale for other things too, keep rules for those as well.
6. **Test it:** on the phone, with Wi-Fi off and Tailscale on, open `http://100.x.y.z:8080`.
7. **Your coding agent on the laptop:** re-run the installer through that address, as in [Your coding agent on the laptop](#your-coding-agent-on-the-laptop) with `100.x.y.z` in place of `10.47.0.1`. The Tailscale address works at home and away.

To drop a lost device, remove it on the admin console's Machines page, and revoke its API token in **Settings → API tokens**.
