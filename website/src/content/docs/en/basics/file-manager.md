---
title: "File Manager"
description: "Browse, edit, and manage files with SailFish's built-in file manager"
---

# File Manager

SailFish includes a visual file manager for browsing and managing local files, as well as remote server files over SFTP. You can complete common file management tasks through the graphical interface—no need to remember command-line syntax.

## Opening the File Manager

Click the **file manager icon** (folder icon) in the left sidebar to open the file browser panel.

The file manager automatically displays different file systems based on the current tab:

- **Local terminal tab**: Shows your machine's file system
- **SSH terminal tab**: Shows the remote server's file system (via SFTP)

> Switching tabs automatically switches the file manager to the corresponding file system.

## Interface Layout

The file manager panel consists of, from top to bottom:

- **Toolbar**: Back, forward, refresh, home directory, new, upload, show hidden files, and more
- **Path bar**: Shows the current path; click to edit and type a path to jump directly
- **File list**: Lists all files and folders in the current directory

## Basic Operations

### Browsing Files

- **Enter a directory**: Click a folder name
- **Go up one level**: Click the back arrow in the toolbar, or click a parent folder name in the path bar
- **Quick jump**: Click the path bar, type a full path (e.g. `/var/log/nginx`), and press Enter
- **Go home**: Click the home directory icon in the toolbar

### Creating Files and Folders

- **New file**: Right-click on empty space → "New File", then enter the filename
- **New folder**: Right-click on empty space → "New Folder", then enter the folder name

You can also use the "New" button in the toolbar.

### Editing Files

Double-click a text file to open it in the built-in editor. The editor supports:

- **Syntax highlighting**: Automatically detects file types (YAML, JSON, Python, Shell, etc.)
- **Live editing**: Press `Ctrl/Cmd + S` to save changes
- **Remote files**: If editing a file over SFTP, changes are automatically synced back to the server on save

File types well suited for editing:

| Type | Examples |
|------|----------|
| Config files | `nginx.conf`, `docker-compose.yml`, `.env`, `config.yaml` |
| Scripts | `deploy.sh`, `backup.py`, `init.js` |
| Documents | `README.md`, `.gitignore`, `Makefile` |

> Binary files (images, archives, etc.) cannot be opened in the editor.

### Rename, Delete, Move

Right-click a file or folder and use the context menu:

- **Rename**: Enter a new name
- **Delete**: Confirm to remove (⚠️ deletion of remote files cannot be undone; use with care)
- **Modify permissions**: View and change Unix file permissions (remote/Linux files only)

### Upload and Download (Remote File Manager)

In the file manager for SSH terminals, file transfer is supported:

- **Upload**: Drag files from Finder/File Explorer onto the panel, or click the "Upload" button in the toolbar
- **Download**: Right-click a remote file and choose "Download", then select a local save location

> For the full range of remote file transfer features, see [SFTP File Transfer](/docs/server/sftp-transfer).

## Let the AI Manage Files

Besides manual operations, you can use natural language to ask the AI to handle more complex file tasks:

### Common File Operations

```
Create a backup directory under /home/user/
```

```
Rename config.yaml.bak to config.yaml
```

```
Delete temporary files older than 7 days in /tmp
```

### File Search

```
Find files larger than 50MB in /var/log
```

```
Search for all Python files containing "TODO" in the project directory
```

```
List files in /home/app modified in the last 24 hours
```

### File Content Analysis

```
Check the last 100 lines of error.log for any errors
```

```
Compare the differences between config.yaml and config.yaml.bak
```

```
Count files by type in the current directory
```

### Batch Operations

```
Move all .png files from /data/images/ to /data/archive/images/
```

```
Replace "var " with "const " in all .js files under src/
```

The AI is better suited than manual actions for complex tasks that combine multiple operations.

## File Search

Enter keywords in the search bar at the top of the file manager to search for files by name in the current directory.

For more powerful search (content search, regex, etc.), ask the AI:

```
Search for all files containing "database connection" in /home/app/src
```
