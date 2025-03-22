# MEGA Import Plugin for Stash

This plugin allows you to import files from your MEGA.nz cloud storage directly into Stash.

## Features

- Connect to your MEGA.nz account
- Browse your MEGA.nz files and folders
- Select multiple files for import
- Automatic file downloading and importing to Stash
- Progress tracking for downloads and imports

## Installation

1. Copy the plugin files to your Stash plugins directory
2. Install the required dependencies:
   ```bash
   cd plugins
   npm install
   ```
3. Configure the plugin in Stash:
   - Go to Settings > Plugins
   - Find "MEGA Import" in the list
   - Enable the plugin
   - Configure your MEGA.nz credentials and download path

## Configuration

The plugin requires the following settings:

- **MEGA Email**: Your MEGA.nz account email
- **MEGA Password**: Your MEGA.nz account password
- **Download Path**: Path where files will be temporarily downloaded before import

## Usage

1. Go to the MEGA Import section in Stash
2. Enter your MEGA.nz credentials if not already configured
3. Browse your MEGA.nz files and folders
4. Select the files you want to import
5. Click "Import Selected" to start the import process

## Security

- Your MEGA.nz credentials are stored securely in Stash's configuration
- Files are downloaded to a temporary location and deleted after import
- All communication with MEGA.nz is encrypted

## Troubleshooting

If you encounter any issues:

1. Check your MEGA.nz credentials
2. Ensure the download path is writable
3. Check the Stash logs for error messages
4. Make sure you have sufficient disk space for temporary downloads

## Support

For issues and feature requests, please create an issue in the Stash repository. 