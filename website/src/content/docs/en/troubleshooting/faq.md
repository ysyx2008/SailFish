---
title: 'FAQ'
description: 'Frequently asked questions about SailFish'
---

# FAQ

## Installation & Launch

### macOS says "Cannot verify developer"

macOS may block apps that are not signed by Apple. To fix:

1. Open **System Settings** → **Privacy & Security**
2. Find SailFish under the security section
3. Click **Open Anyway**

Or run in Terminal:

```bash
xattr -cr /Applications/SailFish.app
```

### Windows says "Windows protected your PC"

Click **More info** → **Run anyway**.

### App crashes or won't start

1. Try removing config and restarting:
   - macOS: `~/Library/Application Support/SailFish/`
   - Windows: `%APPDATA%/SailFish/`
   - Linux: `~/.config/SailFish/`
2. Check the log files in the `logs/` folder in the same directory

## AI

### AI does not reply or stays "thinking"

- Check AI model config (API key, API URL, model name)
- Check network (overseas models may need a proxy)
- Check logs for errors
- Try switching to another model

### Poor reply quality

- Try a different model (Claude, GPT-4o, etc. often perform better)
- Give more detailed instructions
- Provide more context in the conversation

### Token limit exceeded

The conversation context is too long. You can:

- Clear the conversation and start over
- Increase context length in settings
- Break complex tasks into multiple conversations

## SSH

### Connection timeout

- Verify server IP and port
- Ensure the server is reachable (e.g. ping)
- Check that SSH is running on the server
- Check firewall rules for the SSH port

### Key authentication fails

- Confirm the correct private key is selected
- Confirm the server's `~/.ssh/authorized_keys` has the matching public key
- Verify private key permissions (`chmod 600 ~/.ssh/id_rsa`)
- If the key has a passphrase, enter it correctly

### Garbled characters (encoding)

- Set terminal encoding to UTF-8
- Ensure the server's `LANG` is set to `en_US.UTF-8` or `zh_CN.UTF-8`

## Remote Access

### IM bot does not reply

- Ensure SailFish is running
- Ensure IM connection status is **Connected**
- In group chats, you must @mention the bot
- Check that AI model config is correct

### Feishu / DingTalk connection fails

- Verify credentials (watch for extra spaces)
- Feishu: Connect from SailFish first, then submit for review
- DingTalk: Ensure Stream mode is enabled
- Check network access to the platform servers

### Web remote not accessible

- Ensure the gateway is enabled
- Ensure the port is not blocked by a firewall
- On the same network, try accessing via IP:port
- For external access, configure port forwarding or tunneling

## Files & SFTP

### File upload fails

- Check write permissions on the target directory
- Ensure there is enough disk space
- Large files may take longer—wait before retrying

### Editor shows empty file

- The file may be binary; the built-in editor supports text only
- Try another method (e.g. right-click → Download)

## Performance

### High memory usage

SailFish is built on Electron and typically uses about 200–300MB. If it’s unusually high:

- Close unused terminal tabs
- Disconnect idle SSH sessions
- Restart the app

### Terminal output is laggy

- Reduce terminal scroll buffer size
- Avoid huge output in the terminal (e.g. `cat` on large files)
- For large output, redirect to a file and view it separately
