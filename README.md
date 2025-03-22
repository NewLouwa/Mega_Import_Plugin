# MEGA Import Plugin for Stash

A plugin for [Stash](https://github.com/stashapp/stash) that allows you to import files directly from your MEGA.nz cloud storage.

## Features

- Browse your MEGA.nz cloud storage directly from Stash
- Select multiple files for import
- Support for all file types
- Progress tracking for downloads
- Automatic cleanup of temporary files
- Secure authentication with MEGA.nz

## Installation

1. Download the latest release
2. Extract the files to your Stash plugins directory:
   - Windows: `%USERPROFILE%\.stash\plugins`
   - Linux/Mac: `/root/.stash/plugins`
3. Restart Stash
4. Go to Settings > Plugins
5. Enable the "MEGA Import" plugin
6. Configure your MEGA.nz credentials in the plugin settings

## Configuration

The plugin requires the following settings:

- **MEGA Email**: Your MEGA.nz account email
- **MEGA Password**: Your MEGA.nz account password
- **Download Path**: Path where files will be temporarily downloaded before import
- **Allowed Extensions**: Comma-separated list of file extensions to import (e.g. mp4,jpg,png)
- **Delete After Import**: Whether to delete downloaded files after successful import

## Usage

1. Go to the Tasks page in Stash
2. Click "Import from MEGA"
3. Browse your MEGA.nz storage
4. Select files to import
5. Click "Import Selected"

## Development

### Prerequisites

- Node.js 14 or higher
- Yarn package manager
- Git

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/stash-mega-import.git
   cd stash-mega-import
   ```

2. Install dependencies:
   ```bash
   yarn install
   ```

3. Build the plugin:
   ```bash
   yarn build
   ```

### Project Structure

```
mega_import/
├── assets/           # Static assets (images, etc.)
├── utils/           # Utility functions
├── mega_import.js   # Main plugin logic
├── mega_import.jsx  # React component
├── mega_import.css  # Styles
├── mega_import.yml  # Plugin configuration
└── README.md        # This file
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- [Stash](https://github.com/stashapp/stash) - The main application
- [MEGA.nz](https://mega.nz) - Cloud storage service 