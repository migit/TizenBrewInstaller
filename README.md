# TizenBrew Installer – Linux & Arch Linux Improvements 

A community-maintained fork of [TizenBrew Installer](https://github.com/reisxd/TizenBrewInstaller).

This fork improves the installation and build experience on Linux, with particular attention to Arch Linux. It includes fixes for frontend path resolution, Babel compilation, NCC bundling, and SDB connectivity.

## Features

- Install TizenBrew on compatible Samsung Smart TVs.
- Install Tizen applications (`.wgt` and `.tpk`).
- Samsung certificate creation and package resigning for Tizen 7+.
- SDB connectivity through the desktop installer.
- Web-based installer interface.
- Improved Linux and Arch Linux build support.
- Corrected frontend asset resolution.
- Standalone service bundling using `@vercel/ncc`.

## Requirements

- Samsung Smart TV running Tizen.
- Linux, Windows, or macOS computer.
- Node.js and npm.
- Git.
- Samsung Smart TV Developer Mode enabled.
- Samsung Smart Development Bridge (SDB).

## Arch Linux Installation

### 1. Install system dependencies

```bash
sudo pacman -Syu
sudo pacman -S nodejs npm git
```

Install SDB through a compatible Tizen SDK installation and ensure it is available in your `PATH`.

Verify:

```bash
node --version
npm --version
git --version
sdb version
```

### 2. Clone the repository

```bash
git clone https://github.com/migit/TizenBrewInstaller.git
cd TizenBrewInstaller

```

### 3. Build the frontend

```bash
cd client/ui
npm install --force
npm run build
```

Verify:

```bash
ls -lah dist/
```

Expected structure:

```text
dist/
├── assets/
└── index.html
```

### 4. Install service dependencies

```bash
cd ../services/tizenbrew-installer-service
npm install
```

### 5. Start the installer

```bash
npm start
```

Open:

```text
http://localhost:8091/ui/dist/index.html
```

## Building the Standalone Service

The installer service uses Babel for transpilation and `@vercel/ncc` for bundling.

From the `tizenbrew-installer-service` directory:

```bash
rm -rf transpiled dist
mkdir -p transpiled/utils
npx babel index.js --out-file transpiled/index.js
npx babel utils --out-dir transpiled/utils --copy-files
npx ncc build transpiled/index.js -o dist
```

Run the bundled service:

```bash
node dist/index.js
```

### Automated build

Add this script to `package.json`:

```json
{
  "scripts": {
    "start": "node index.js",
    "build": "mkdir -p transpiled/utils && babel index.js --out-file transpiled/index.js && babel utils --out-dir transpiled/utils --copy-files && ncc build transpiled/index.js -o dist"
  }
}
```

This explicitly compiles the entry point and utility modules separately to ensure local utility dependencies are available during bundling.

## Connecting to a Samsung TV

### 1. Enable Developer Mode

On your Samsung TV:

1. Open the **Apps** section.
2. Enter `12345` using your remote.
3. Enable **Developer Mode**.
4. Set **Host PC IP** to your computer's local IP address.
5. Confirm the settings.
6. Restart the TV by holding the remote's power button until the Samsung logo appears.

### 2. Find your computer's IP address

On Arch Linux:

```bash
ip -4 addr
```

Example:

```text
192.168.1.104
```

Set this address as the **Host PC IP** in the TV's Developer Mode settings.

### 3. Check network connectivity

Replace the example address with your TV's IP:

```bash
ping -c 4 192.168.1.100
```

Check whether the SDB port is reachable:

```bash
bash -c 'timeout 3 bash -c "</dev/tcp/192.168.1.100/26101" && echo OPEN || echo CLOSED'
```

### 4. Connect using SDB

```bash
sdb start-server
sdb connect 192.168.1.100:26101
sdb devices
```

Successful connection example:

```text
List of devices attached
192.168.1.100:26101    device
```

### 5. Connect through TizenBrew Installer

1. Open TizenBrew Installer in your browser.
2. Select **Connect to TV**.
3. Enter the TV's IP address.
4. Confirm the connection.
5. Install TizenBrew or another supported Tizen package.

## Troubleshooting

### Frontend not found

If the browser displays:

```text
Cannot GET /ui/dist/index.html
```

Check that the frontend has been built:

```bash
ls -lah ~/TizenBrewInstaller/client/ui/dist/
```

If the directory is missing or empty, rebuild:

```bash
cd ~/TizenBrewInstaller/client/ui
npm install --force
npm run build
```

### Port 8091 already in use

Check which process is using the port:

```bash
ss -ltnp | grep 8091
```

Stop the previous installer process before starting another instance.

### SDB connection fails

Verify:

- Developer Mode is enabled.
- Host PC IP matches your computer's current IP.
- The TV has been restarted.
- Port `26101` is reachable.
- SDB is installed and available in `PATH`.

Restart the SDB server:

```bash
sdb kill-server
sdb start-server
sdb connect 192.168.1.100:26101
sdb devices
```

### ADB connection closed

If SDB reports a connected device but the installer loses its connection:

- Check whether the TV remains reachable.
- Verify the TV's Developer Mode settings.
- Inspect the installer service logs.
- Check that the installer is connecting to the correct TV IP and port.

### Missing utility modules after building

If the bundled service reports:

```text
Error: Cannot find module './utils/configuration.js'
```

Rebuild:

```bash
rm -rf transpiled dist
mkdir -p transpiled/utils
npx babel index.js --out-file transpiled/index.js
npx babel utils --out-dir transpiled/utils --copy-files
npx ncc build transpiled/index.js -o dist
```

## Project Structure

```text
TizenBrewInstaller/
├── client/
│   ├── ui/
│   │   └── dist/
│   └── services/
│       └── tizenbrew-installer-service/
│           ├── index.js
│           ├── utils/
│           ├── transpiled/
│           ├── dist/
│           └── package.json
├── README.md
└── LICENSE
```

## Development Notes

This fork includes improvements developed and tested on Arch Linux.

Key improvements:

- Explicit Babel compilation of the service entry point.
- Separate compilation of utility modules.
- NCC bundling of the transpiled service.
- Frontend directory resolution improvements.
- Linux-oriented installation and troubleshooting documentation.

The existing SDB connection implementation is retained.

## Credits

Original project:

- [reisxd/TizenBrewInstaller](https://github.com/reisxd/TizenBrewInstaller)
- [reisxd/TizenBrew](https://github.com/reisxd/TizenBrew)

This repository is an independent community-maintained fork and is not an official upstream release.

## License

GPL-3.0-only.

See `LICENSE` for details.
