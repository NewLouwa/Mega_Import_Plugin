# MEGA Import Plugin for Stash

A Stash plugin that allows you to import media directly from MEGA.nz cloud storage by logging into your MEGA account and browsing your files.

## Installation

For Stash 0.15.0 and higher:

1. Download this repository
2. Place the `mega_import` folder in your Stash plugins directory:
   - Default: `~/.stash/plugins/`
   - Custom: `.local/plugins/` (if using customized setup)
3. Restart Stash or click "Reload Plugins" in the Plugins settings

## Usage

1. Click the MEGA Import button in the top navigation bar (shows the MEGA logo)
2. Log in with your MEGA.nz account credentials
3. Browse your MEGA cloud storage and select files to import
4. Click "Import Selected" to download the selected files to your Stash library

### Features

- Direct login to your MEGA account
- Browse your entire MEGA cloud storage
- Navigate through folders
- Select multiple files for import
- Visual file selection with checkboxes
- Clear path navigation
- Tabbed interface for organization
- Account management within the plugin

## Requirements

- Stash 0.15.0 or higher
- Python 3.6+ (with `mega.py` library installed)
- Internet connection for accessing MEGA.nz

## Configuration

No additional configuration is required. Simply install the plugin and restart Stash.

## Development

This plugin is under active development. Future features will include:

- Full MEGA.nz API integration with secure authentication
- Advanced file filtering and searching
- Folder recursive import with structure preservation
- Import history tracking
- Batch operations
- Background processing for large imports
- Drag and drop selection
- File preview capabilities

## Troubleshooting

If the plugin doesn't work:

1. Check if all required files are present in the plugin folder:
   - `mega_import.js`
   - `mega_import.py`
   - `mega_import.css`
   - `info.json`
   - `assets/` directory with MEGA logo

2. Ensure Python is installed and available in your PATH
3. Check Stash logs for any errors
4. Make sure you have an internet connection to access MEGA.nz
5. Verify your MEGA.nz account credentials are correct

## Credits

- MEGA.nz for their cloud storage service
- Stash community for the plugin framework

## License

MIT License

## Contact

For issues or feature requests, please create an issue on the GitHub repository.

---

**Note**: This plugin is not affiliated with or endorsed by MEGA.nz. 