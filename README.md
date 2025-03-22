# MEGA Import Plugin for Stash

This plugin allows importing files from MEGA.nz directly into Stash.

## Installation

1. Copy the `mega_import` folder to your Stash plugins directory
   - Typically located at `~/.stash/plugins/` on Linux/Mac
   - Typically located at `C:\Users\USERNAME\.stash\plugins\` on Windows
   - Or place in your `.local/plugins/` directory if using a customized setup
2. Restart Stash or reload plugins from the Settings > Plugins page
3. The plugin will add a MEGA Import button to the top navigation bar

## Usage

1. Click the MEGA Import button in the top navigation bar
2. Enter a MEGA.nz URL (file or folder link)
3. Click "Import from MEGA"
4. The files will be downloaded and imported into your Stash library

## Requirements

- Stash v0.15.0 or higher
- Python 3.6 or higher
- Internet connection for accessing MEGA.nz

## Development

This plugin is still in development. Current features:
- UI integration with navbar button
- MEGA.nz URL parsing
- Plugin API integration

Planned features:
- Full MEGA.nz API integration
- File download implementation
- Import queue management
- Progress reporting
- Batch imports
- Custom import paths

## Troubleshooting

If the plugin doesn't appear in Stash:
1. Check Stash logs for any errors
2. Ensure the plugin folder is in the correct location
3. Verify that all required files are present (mega_import.yml, mega_import.js, mega_import.css, mega_import.py)
4. Make sure the plugin configuration is valid
5. Check that Python is installed and available in your path

## License

MIT 