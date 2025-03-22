// MEGA Import Plugin
// This plugin allows importing files from MEGA.nz to Stash

const { MegaClient } = require('mega');
const fs = require('fs');
const path = require('path');

// Global variables
let megaClient = null;
let currentPath = '/';
let selectedFiles = new Set();

// Initialize MEGA client
async function initMegaClient() {
    const email = input.Args.mega_email;
    const password = input.Args.mega_password;
    
    if (!email || !password) {
        throw new Error('MEGA credentials not configured');
    }

    megaClient = new MegaClient({
        email: email,
        password: password
    });

    await megaClient.login();
    log.Info('Successfully connected to MEGA.nz');
}

// List files in current directory
async function listFiles(dirPath = '/') {
    if (!megaClient) {
        await initMegaClient();
    }

    const files = await megaClient.readdir(dirPath);
    return files.map(file => ({
        name: file.name,
        path: file.path,
        size: file.size,
        type: file.type,
        modified: file.modified
    }));
}

// Download file from MEGA
async function downloadFile(filePath, localPath) {
    if (!megaClient) {
        await initMegaClient();
    }

    const file = await megaClient.download(filePath);
    await fs.promises.writeFile(localPath, file);
    return localPath;
}

// Import file to Stash
async function importToStash(localPath) {
    const mutation = `
        mutation ImportFile($path: String!) {
            importFile(path: $path) {
                id
                path
            }
        }
    `;

    const result = await gql.Do(mutation, { path: localPath });
    return result;
}

// Main plugin function
async function main() {
    try {
        // Initialize MEGA client
        await initMegaClient();

        // Get current directory contents
        const files = await listFiles(currentPath);
        
        // Return the file list for UI rendering
        return {
            Output: {
                files: files,
                currentPath: currentPath
            }
        };
    } catch (error) {
        log.Error(`Error: ${error.message}`);
        return {
            Error: error.message
        };
    }
}

// Handle file selection
async function handleFileSelect(filePath) {
    try {
        const downloadPath = input.Args.download_path || path.join(process.cwd(), 'downloads');
        
        // Create download directory if it doesn't exist
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath, { recursive: true });
        }

        // Download file
        const localPath = path.join(downloadPath, path.basename(filePath));
        await downloadFile(filePath, localPath);

        // Import to Stash
        await importToStash(localPath);

        log.Info(`Successfully imported ${filePath}`);
        return {
            Output: {
                success: true,
                message: `Imported ${filePath}`
            }
        };
    } catch (error) {
        log.Error(`Error importing file: ${error.message}`);
        return {
            Error: error.message
        };
    }
}

// Handle directory navigation
async function handleNavigate(newPath) {
    try {
        currentPath = newPath;
        const files = await listFiles(currentPath);
        
        return {
            Output: {
                files: files,
                currentPath: currentPath
            }
        };
    } catch (error) {
        log.Error(`Error navigating directory: ${error.message}`);
        return {
            Error: error.message
        };
    }
}

// Export functions for UI
module.exports = {
    main,
    handleFileSelect,
    handleNavigate
};

(function () {
    const { React } = PluginApi.libraries;
    const { Form, Button } = PluginApi.components;
    
    window.MegaImport = () => {
        const [url, setUrl] = React.useState("");
        const [isLoading, setIsLoading] = React.useState(false);
        const { Toast } = PluginApi.hooks.useToast();

        const handleImport = async () => {
            if (!url) {
                Toast.error("Please enter a MEGA.nz URL");
                return;
            }

            setIsLoading(true);
            try {
                // Call our task
                const result = await PluginApi.utils.StashService.runPluginTask("mega_import", "Import from MEGA", { url });
                
                if (result.output === "ok") {
                    Toast.success("Successfully imported files from MEGA");
                } else {
                    Toast.error("Failed to import: " + result.output);
                }
            } catch (error) {
                Toast.error("Error during import: " + error.message);
            } finally {
                setIsLoading(false);
            }
        };

        return React.createElement("div", { className: "mega-import-container" }, [
            React.createElement("h2", { key: "title" }, "Import from MEGA.nz"),
            React.createElement(Form.Group, { key: "form" }, [
                React.createElement(Form.Label, { key: "label" }, "MEGA.nz URL"),
                React.createElement(Form.Control, {
                    key: "input",
                    type: "text",
                    placeholder: "https://mega.nz/...",
                    value: url,
                    onChange: (e) => setUrl(e.target.value),
                    disabled: isLoading
                }),
                React.createElement(Button, {
                    key: "button",
                    variant: "primary",
                    onClick: handleImport,
                    disabled: isLoading || !url
                }, isLoading ? "Importing..." : "Import")
            ])
        ]);
    };
})(); 