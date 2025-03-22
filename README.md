# MEGA Import Plugin for Stash

A plugin for [Stash](https://github.com/stashapp/stash) that allows you to import files directly from MEGA.nz into your Stash library.

## Features

- Browse your MEGA.nz storage directly from Stash
- Select multiple files for import
- Support for all file types
- Progress tracking during import
- Automatic cleanup of temporary files
- Secure authentication with MEGA.nz

## Installation

### Adding Local Source Plugin

1. Download the latest release from the [releases page](https://github.com/NewLouwa/Mega_Import_Plugin/releases)
2. Extract the files to your Stash plugins directory:
   - Windows: `%APPDATA%\stash\plugins\mega_import`
   - Linux/Mac: `~/.local/share/stash/plugins/mega_import`
3. Add the plugin as a local source in Stash:
   - Go to Settings -> Plugins
   - Click "Add Local Source"
   - Enter the following details:
     - Name: MEGA Import
     - URL: https://github.com/NewLouwa/Mega_Import_Plugin
     - Path: `%APPDATA%\stash\plugins\mega_import` (Windows) or `~/.local/share/stash/plugins/mega_import` (Linux/Mac)
4. Restart Stash
5. Enable the plugin in Settings -> Plugins
6. Configure your MEGA.nz credentials in the plugin settings

### Configuration

The plugin requires the following settings:

- **MEGA Email**: Your MEGA.nz account email
- **MEGA Password**: Your MEGA.nz account password
- **Download Path**: Temporary directory for downloading files (default: system temp directory)
- **Allowed Extensions**: Comma-separated list of file extensions to allow (default: all)
- **Delete After Import**: Whether to delete files from MEGA after successful import (default: false)

## Usage

1. Go to the Tasks page in Stash
2. Click the "Import from MEGA" button
3. Browse your MEGA.nz storage
4. Select the files you want to import
5. Click "Import Selected" to start the import process

## Development

### Prerequisites

- Node.js 16 or later
- Yarn package manager
- Git

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/NewLouwa/Mega_Import_Plugin.git
   cd Mega_Import_Plugin
   ```

2. Install dependencies:
   ```bash
   yarn install
   ```

3. Build the plugin:
   ```bash
   yarn build
   ```

4. Copy the built files to your Stash plugins directory

### Project Structure

```
mega_import/
├── src/
│   ├── index.tsx        # Main plugin entry point
│   ├── components/      # React components
│   └── utils/          # Utility functions
├── assets/             # Static assets (images, etc.)
├── mega_import.yml     # Plugin configuration
├── mega_import.css     # Plugin styles
└── package.json        # Dependencies and scripts
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Stash](https://github.com/stashapp/stash) - The main application
- [MEGA.nz](https://mega.nz) - The cloud storage service 