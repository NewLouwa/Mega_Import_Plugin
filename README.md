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
3. After successful login, you'll be redirected to the MEGA Cloud Browser page
4. Browse your MEGA cloud storage and select files to import
5. Click "Import Selected" to download the selected files to your Stash library
6. When finished, click "Back to Stash" to return to the main interface

### Features

- Direct login to your MEGA account
- Dedicated browser page for MEGA cloud storage
- Navigate through folders with intuitive interface
- Select multiple files for import
- Visual file selection with checkboxes
- Clear path navigation
- Full-screen browsing experience
- Easy return to Stash main interface with "Back to Stash" button
- Account management integrated with the plugin
- Direct MEGA API integration (uses megajs library)

## Requirements

- Stash 0.15.0 or higher
- Python 3.6+ (with `mega.py` library installed)
- Internet connection for accessing MEGA.nz

## Configuration

No additional configuration is required. Simply install the plugin and restart Stash.

## Technical Implementation

The plugin uses a modular architecture:

- `MegaApiClient`: A JavaScript module that handles all interactions with the MEGA API
- `MegaImportComponent`: The main React component that coordinates the UI
- `MegaBrowserPage`: A dedicated page component for browsing MEGA files
- Direct integration with the MEGA.nz API via the megajs library

### MEGA API Integration Pattern

The plugin implements a wrapper around the mega.js library through the `MegaApiClient` module:

```javascript
// MEGA API Integration Module
const MegaApiClient = {
  // Private property to store the mega.js instance
  _megaInstance: null,
  
  // Initialize the client and authenticate
  initialize: async function(email, password) {
    try {
      // Create a new instance with credentials
      this._megaInstance = new Mega({ email, password });
      
      // Login to MEGA account
      await this._megaInstance.login(email, password);
      
      // Return account info
      return { 
        success: true,
        // Account details
      };
    } catch (error) {
      console.error("MEGA API initialization error:", error);
      throw new Error(error.message || "Failed to initialize MEGA client");
    }
  },
  
  // Other methods for file operations, downloads, etc.
}
```

This pattern encapsulates all MEGA API interactions and provides a consistent interface for UI components.

## Development

This plugin is under active development. Future features will include:

- Enhanced MEGA.nz API integration with secure authentication
- Advanced file filtering and searching
- Folder recursive import with structure preservation
- Import history tracking
- Batch operations
- Background processing for large imports
- Drag and drop selection
- File preview capabilities
- User account management

## Troubleshooting

If the plugin doesn't work:

1. Check if all required files are present in the plugin folder:
   - `mega_import.js`
   - `mega_import.py`
   - `mega_import.css`
   - `info.json`

2. Ensure Python is installed and available in your PATH
3. Check Stash logs for any errors
4. Make sure you have an internet connection to access MEGA.nz
5. Verify your MEGA.nz account credentials are correct

## Credits

- MEGA.nz for their cloud storage service
- megajs library for MEGA API integration
- Stash community for the plugin framework

## License

MIT License

## Contact

For issues or feature requests, please create an issue on the GitHub repository.

---

**Note**: This plugin is not affiliated with or endorsed by MEGA.nz. 