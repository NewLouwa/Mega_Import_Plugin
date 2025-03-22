# MEGA Import Plugin for Stash

This plugin allows importing files from MEGA.nz directly into Stash.

## Installation

1. Copy the `mega_import` folder to your Stash plugins directory
   - Typically located at `~/.stash/plugins/` on Linux/Mac
   - Typically located at `C:\Users\USERNAME\.stash\plugins\` on Windows
2. Restart Stash or reload plugins from the Settings > Plugins page
3. The plugin should appear in the Tools menu

## Usage

1. Navigate to "Tools > MEGA Import" in the Stash UI
2. Enter a MEGA.nz URL (file or folder link)
3. Click "Import from MEGA"
4. The files will be downloaded and imported into your Stash library

## Requirements

- Stash v0.15.0 or higher

## Development

This plugin is still in development. Current features:
- Basic UI integration
- MEGA.nz URL parsing

Planned features:
- File download implementation
- Import queue management
- Progress reporting
- Batch imports
- Custom import paths

## Troubleshooting

If the plugin doesn't appear in Stash:
1. Check Stash logs for any errors
2. Ensure the plugin folder is in the correct location
3. Verify that all required files are present
4. Make sure the plugin configuration (mega_import.yml) is valid

## License

MIT 