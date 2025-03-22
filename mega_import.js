"use strict";
(function() {
  const api = window.PluginApi;
  const React = api.React;
  const { Button, Modal, Form, Tabs, Tab } = api.libraries.Bootstrap;
  const { faCloudDownloadAlt, faSpinner, faSignInAlt, faFolder, faFile, faArrowLeft, faHome } = api.libraries.FontAwesomeSolid;
  const { Icon } = api.components;

  // Define MEGA logo as inline SVG
  const megaLogoSVG = '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="20" height="20" viewBox="0 0 361.4 361.4"><path fill="#d9272e" d="M180.7 0C80.9 0 0 80.9 0 180.7c0 99.8 80.9 180.7 180.7 180.7 99.8 0 180.7-80.9 180.7-180.7C361.4 80.9 280.5 0 180.7 0Zm93.8 244.6c0 3.1-2.5 5.6-5.6 5.6h-23.6c-3.1 0-5.6-2.5-5.6-5.6v-72.7c0-.6-.7-.9-1.2-.5l-50 50c-4.3 4.3-11.4 4.3-15.7 0l-50-50c-.4-.4-1.2-.1-1.2.5v72.7c0 3.1-2.5 5.6-5.6 5.6H92.4c-3.1 0-5.6-2.5-5.6-5.6V116.8c0-3.1 2.5-5.6 5.6-5.6h16.2c2.9 0 5.8 1.2 7.9 3.3l62.2 62.2c1.1 1.1 2.8 1.1 3.9 0l62.2-62.2c2.1-2.1 4.9-3.3 7.9-3.3h16.2c3.1 0 5.6 2.5 5.6 5.6v127.8z"/></svg>';

  // Larger version for modal header
  const megaLogoSVGLarge = '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="30" height="30" viewBox="0 0 361.4 361.4"><path fill="#d9272e" d="M180.7 0C80.9 0 0 80.9 0 180.7c0 99.8 80.9 180.7 180.7 180.7 99.8 0 180.7-80.9 180.7-180.7C361.4 80.9 280.5 0 180.7 0Zm93.8 244.6c0 3.1-2.5 5.6-5.6 5.6h-23.6c-3.1 0-5.6-2.5-5.6-5.6v-72.7c0-.6-.7-.9-1.2-.5l-50 50c-4.3 4.3-11.4 4.3-15.7 0l-50-50c-.4-.4-1.2-.1-1.2.5v72.7c0 3.1-2.5 5.6-5.6 5.6H92.4c-3.1 0-5.6-2.5-5.6-5.6V116.8c0-3.1 2.5-5.6 5.6-5.6h16.2c2.9 0 5.8 1.2 7.9 3.3l62.2 62.2c1.1 1.1 2.8 1.1 3.9 0l62.2-62.2c2.1-2.1 4.9-3.3 7.9-3.3h16.2c3.1 0 5.6 2.5 5.6 5.6v127.8z"/></svg>';

  // Add MEGA API integration module
  const MegaApiClient = {
    storage: null,
    
    // Initialize the MEGA API client with credentials
    login: async function(email, password, rememberMe) {
      try {
        // This would be replaced with actual MEGA API calls using megajs library
        // For now, we're just simulating the login
        
        // Example of how it would work with the real API:
        // const { Storage } = await import('megajs');
        // this.storage = new Storage({ email, password });
        // await this.storage.ready;
        
        // Simulate login delay
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Return simulated user info
        return {
          success: true,
          name: "MEGA User",
          email: email,
          spaceUsed: Math.floor(Math.random() * 1000000000),
          spaceTotal: 50000000000
        };
      } catch (error) {
        console.error("MEGA API login error:", error);
        throw new Error(error.message || "Login failed");
      }
    },
    
    // Get files and folders at a specific path
    listFiles: async function(path) {
      try {
        // This would be replaced with actual MEGA API calls
        // For example:
        // const folder = this.storage.root.navigate(path.split('/').filter(p => p));
        // return folder.children.map(file => ({
        //   id: file.nodeId,
        //   name: file.name,
        //   type: file.directory ? 'folder' : 'file',
        //   size: file.size,
        //   path: path + '/' + file.name
        // }));
        
        // Simulate API delay
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Return simulated files based on the path
        if (path === '/') {
          return [
            { id: '1', name: 'Documents', type: 'folder', path: '/Documents' },
            { id: '2', name: 'Images', type: 'folder', path: '/Images' },
            { id: '3', name: 'Videos', type: 'folder', path: '/Videos' },
            { id: '4', name: 'file1.jpg', type: 'file', size: '1.5 MB', path: '/file1.jpg' },
            { id: '5', name: 'file2.mp4', type: 'file', size: '15 MB', path: '/file2.mp4' },
          ];
        } else if (path === '/Documents') {
          return [
            { id: '10', name: 'Work', type: 'folder', path: '/Documents/Work' },
            { id: '11', name: 'Personal', type: 'folder', path: '/Documents/Personal' },
            { id: '12', name: 'document1.pdf', type: 'file', size: '2.2 MB', path: '/Documents/document1.pdf' },
            { id: '13', name: 'document2.docx', type: 'file', size: '1.1 MB', path: '/Documents/document2.docx' },
          ];
        } else if (path === '/Images') {
          return [
            { id: '20', name: 'Vacation', type: 'folder', path: '/Images/Vacation' },
            { id: '21', name: 'image1.jpg', type: 'file', size: '3.5 MB', path: '/Images/image1.jpg' },
            { id: '22', name: 'image2.png', type: 'file', size: '2.7 MB', path: '/Images/image2.png' },
          ];
        } else if (path === '/Videos') {
          return [
            { id: '30', name: 'video1.mp4', type: 'file', size: '25 MB', path: '/Videos/video1.mp4' },
            { id: '31', name: 'video2.mov', type: 'file', size: '40 MB', path: '/Videos/video2.mov' },
          ];
        }
        
        // Return empty array for unknown paths
        return [];
      } catch (error) {
        console.error("MEGA API list files error:", error);
        throw new Error(error.message || "Failed to list files");
      }
    },
    
    // Download files from MEGA
    downloadFiles: async function(filePaths) {
      try {
        // This would be replaced with actual MEGA API calls
        // For example with multiple files:
        // const results = await Promise.all(filePaths.map(async (path) => {
        //   const file = this.storage.root.navigate(path.split('/').filter(p => p));
        //   const buffer = await file.downloadBuffer();
        //   // Then handle the buffer for saving
        //   return { name: path, status: 'Success' };
        // }));
        
        // Simulate download delay
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Return simulated results
        return {
          success: true,
          imported: filePaths.length,
          items: filePaths.map(path => ({ name: path, status: 'Success' }))
        };
      } catch (error) {
        console.error("MEGA API download error:", error);
        throw new Error(error.message || "Download failed");
      }
    },
    
    // Logout from MEGA
    logout: async function() {
      try {
        // This would be replaced with actual MEGA API calls
        // For example: await this.storage.close();
        
        this.storage = null;
        return { success: true };
      } catch (error) {
        console.error("MEGA API logout error:", error);
        throw new Error(error.message || "Logout failed");
      }
    }
  };

  // Define main component with loading states
  const MegaImportComponent = () => {
    const [display, setDisplay] = React.useState(false);
    const [isLoading, setIsLoading] = React.useState(false);
    const [isLoggedIn, setIsLoggedIn] = React.useState(false);
    const [email, setEmail] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [rememberMe, setRememberMe] = React.useState(false);
    const [files, setFiles] = React.useState([]);
    const [currentPath, setCurrentPath] = React.useState('/');
    const [selectedItems, setSelectedItems] = React.useState([]);
    const [activeTab, setActiveTab] = React.useState('login');
    const [results, setResults] = React.useState(null);
    const toast = api.hooks.useToast(); // Toast notifications
    
    const enableModal = () => setDisplay(true);
    const disableModal = () => {
      // Reset state when closing
      if (!isLoggedIn) {
        setEmail('');
        setPassword('');
      }
      setDisplay(false);
    };
    
    const handleLogin = async () => {
      if (!email || !password) {
        toast.error("Please enter your email and password");
        return;
      }
      
      setIsLoading(true);
      try {
        // Use the MEGA API client
        const result = await MegaApiClient.login(email, password, rememberMe);
        
        setIsLoggedIn(true);
        
        // Instead of just changing the tab, close the modal and navigate to MEGA browser page
        disableModal();
        
        // Navigate to MEGA browser page
        api.utils.navigate('/mega-browser');
        
        // Get files using the API client
        const filesList = await MegaApiClient.listFiles('/');
        setFiles(filesList);
        
        toast.success("Logged in successfully");
      } catch (error) {
        console.error("Login failed:", error);
        toast.error("Login failed: " + (error.message || "Unknown error"));
      } finally {
        setIsLoading(false);
      }
    };
    
    const handleLogout = () => {
      setIsLoggedIn(false);
      setActiveTab('login');
      setFiles([]);
      setCurrentPath('/');
      setSelectedItems([]);
      toast.success("Logged out successfully");
    };
    
    const handleImport = async () => {
      if (selectedItems.length === 0) {
        toast.error("Please select files or folders to import");
        return;
      }
      
      setIsLoading(true);
      try {
        // Use the MEGA API client
        const results = await MegaApiClient.downloadFiles(selectedItems);
        
        setResults(results);
        toast.success(`${selectedItems.length} items imported successfully`);
      } catch (error) {
        console.error("Import failed:", error);
        toast.error("Import failed: " + (error.message || "Unknown error"));
      } finally {
        setIsLoading(false);
      }
    };
    
    const toggleItemSelection = (item) => {
      if (selectedItems.includes(item.path)) {
        setSelectedItems(selectedItems.filter(i => i !== item.path));
      } else {
        setSelectedItems([...selectedItems, item.path]);
      }
    };
    
    const navigateToFolder = async (path) => {
      setCurrentPath(path);
      setIsLoading(true);
      
      try {
        // Get files using the API client
        const filesList = await MegaApiClient.listFiles(path);
        setFiles(filesList);
      } catch (error) {
        console.error("Failed to navigate to folder:", error);
        toast.error("Failed to load folder contents: " + (error.message || "Unknown error"));
      } finally {
        setIsLoading(false);
      }
    };
    
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(NavButton, { onClickHandler: enableModal }),
      React.createElement(MegaImportModal, {
        displayState: display,
        onCloseHandler: disableModal,
        email: email,
        setEmail: setEmail,
        password: password,
        setPassword: setPassword,
        rememberMe: rememberMe,
        setRememberMe: setRememberMe,
        handleLogin: handleLogin,
        handleLogout: handleLogout,
        handleImport: handleImport,
        isLoading: isLoading,
        isLoggedIn: isLoggedIn,
        files: files,
        currentPath: currentPath,
        navigateToFolder: navigateToFolder,
        selectedItems: selectedItems,
        toggleItemSelection: toggleItemSelection,
        activeTab: activeTab,
        setActiveTab: setActiveTab,
        results: results
      })
    );
  };

  // NavBar Button Component
  const NavButton = ({ onClickHandler }) => {
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        Button,
        {
          className: "nav-utility minimal",
          title: "MEGA Import",
          onClick: onClickHandler,
          dangerouslySetInnerHTML: { __html: megaLogoSVG }
        }
      )
    );
  };

  // Modal Component
  const MegaImportModal = ({
    displayState,
    onCloseHandler,
    email,
    setEmail,
    password,
    setPassword,
    rememberMe,
    setRememberMe,
    handleLogin,
    handleLogout,
    handleImport,
    isLoading,
    isLoggedIn,
    files,
    currentPath,
    navigateToFolder,
    selectedItems,
    toggleItemSelection,
    activeTab,
    setActiveTab,
    results
  }) => {
    return React.createElement(
      Modal,
      { 
        show: displayState, 
        onHide: onCloseHandler,
        size: "lg"
      },
      React.createElement(
        Modal.Header,
        { closeButton: true },
        React.createElement(
          "div",
          { className: "modal-title-with-logo" },
          React.createElement("span", {
            dangerouslySetInnerHTML: { __html: megaLogoSVGLarge },
            className: "mega-logo-header"
          }),
          React.createElement(Modal.Title, null, "MEGA Cloud Import")
        )
      ),
      React.createElement(
        Modal.Body,
        null,
        React.createElement(
          Tabs,
          { 
            id: "mega-import-tabs", 
            activeKey: activeTab,
            onSelect: (k) => setActiveTab(k),
            className: "mb-3"
          },
          React.createElement(
            Tab,
            { 
              eventKey: "login", 
              title: isLoggedIn ? "Account" : "Login",
              disabled: isLoading
            },
            isLoggedIn ? 
              // Account info when logged in
              React.createElement(
                "div",
                { className: "account-info" },
                React.createElement("h4", null, "Account Information"),
                React.createElement("p", null, `Email: ${email}`),
                React.createElement("p", null, "Status: Connected"),
                React.createElement(
                  Button,
                  { 
                    variant: "outline-danger", 
                    onClick: handleLogout,
                    disabled: isLoading
                  },
                  "Logout"
                )
              ) : 
              // Login form when not logged in
              React.createElement(
                Form,
                null,
                React.createElement(
                  Form.Group,
                  { className: "mb-3" },
                  React.createElement(Form.Label, null, "Email"),
                  React.createElement(Form.Control, {
                    type: "email",
                    value: email,
                    onChange: (e) => setEmail(e.target.value),
                    placeholder: "Enter your MEGA email",
                    disabled: isLoading
                  })
                ),
                React.createElement(
                  Form.Group,
                  { className: "mb-3" },
                  React.createElement(Form.Label, null, "Password"),
                  React.createElement(Form.Control, {
                    type: "password",
                    value: password,
                    onChange: (e) => setPassword(e.target.value),
                    placeholder: "Enter your MEGA password",
                    disabled: isLoading
                  })
                ),
                React.createElement(
                  Form.Group,
                  { className: "mb-3" },
                  React.createElement(
                    Form.Check,
                    {
                      type: "checkbox",
                      label: "Remember me",
                      checked: rememberMe,
                      onChange: (e) => setRememberMe(e.target.checked),
                      disabled: isLoading
                    }
                  )
                ),
                React.createElement(
                  Button,
                  { 
                    variant: "primary", 
                    onClick: handleLogin,
                    disabled: isLoading
                  },
                  isLoading ? [
                    React.createElement(Icon, { icon: faSpinner, spin: true }),
                    " Logging in..."
                  ] : [
                    React.createElement(Icon, { icon: faSignInAlt }),
                    " Login"
                  ]
                )
              )
          ),
          React.createElement(
            Tab,
            { 
              eventKey: "browser", 
              title: "File Browser",
              disabled: !isLoggedIn || isLoading
            },
            React.createElement(
              "div",
              { className: "file-browser" },
              React.createElement(
                "div",
                { className: "path-navigation mb-2" },
                React.createElement("strong", null, "Current path: "),
                React.createElement("span", null, currentPath)
              ),
              React.createElement(
                "div",
                { className: "files-container" },
                currentPath !== '/' && React.createElement(
                  "div",
                  { 
                    className: "file-item", 
                    onClick: () => navigateToFolder(currentPath.substring(0, currentPath.lastIndexOf('/')) || '/')
                  },
                  React.createElement(Icon, { icon: faFolder }),
                  React.createElement("span", null, "..")
                ),
                files.map(file => React.createElement(
                  "div",
                  { 
                    key: file.id,
                    className: `file-item ${selectedItems.includes(file.path) ? 'selected' : ''}`,
                    onClick: () => file.type === 'folder' ? navigateToFolder(file.path) : toggleItemSelection(file)
                  },
                  React.createElement(Icon, { icon: file.type === 'folder' ? faFolder : faFile }),
                  React.createElement("span", { className: "file-name" }, file.name),
                  file.type === 'file' && React.createElement("span", { className: "file-size" }, file.size),
                  file.type === 'file' && React.createElement(
                    Form.Check,
                    {
                      type: "checkbox",
                      checked: selectedItems.includes(file.path),
                      onChange: (e) => {
                        e.stopPropagation();
                        toggleItemSelection(file);
                      },
                      onClick: (e) => e.stopPropagation()
                    }
                  )
                ))
              ),
              selectedItems.length > 0 && React.createElement(
                "div",
                { className: "selection-info mt-2" },
                React.createElement("span", null, `${selectedItems.length} items selected`)
              )
            )
          ),
          results && React.createElement(
            Tab,
            { 
              eventKey: "results", 
              title: "Results",
            },
            React.createElement(
              "div",
              { className: "import-results" },
              React.createElement("h4", null, "Import Results"),
              React.createElement(
                "div",
                { className: "result-summary mb-2" },
                React.createElement("p", null, `Successfully imported ${results.imported} items.`)
              ),
              React.createElement(
                "div",
                { className: "result-details" },
                React.createElement("pre", null, JSON.stringify(results.items, null, 2))
              )
            )
          )
        )
      ),
      React.createElement(
        Modal.Footer,
        null,
        React.createElement(
          Button,
          { variant: "secondary", onClick: onCloseHandler },
          "Close"
        ),
        isLoggedIn && activeTab === 'browser' && React.createElement(
          Button,
          { 
            variant: "primary", 
            onClick: handleImport,
            disabled: isLoading || selectedItems.length === 0
          },
          isLoading ? [
            React.createElement(Icon, { icon: faSpinner, spin: true }),
            " Importing..."
          ] : [
            React.createElement(Icon, { icon: faCloudDownloadAlt }),
            " Import Selected"
          ]
        )
      )
    );
  };

  // Create a dedicated page component for MEGA browser
  const MegaBrowserPage = () => {
    const [files, setFiles] = React.useState([]);
    const [currentPath, setCurrentPath] = React.useState('/');
    const [selectedItems, setSelectedItems] = React.useState([]);
    const [isLoading, setIsLoading] = React.useState(false);
    const [results, setResults] = React.useState(null);
    const toast = api.hooks.useToast();
    
    // Navigate back to the main Stash interface
    const navigateToStash = () => {
      api.utils.navigate('/');
    };
    
    // Similar functions as in the modal component
    const toggleItemSelection = (item) => {
      if (selectedItems.includes(item.path)) {
        setSelectedItems(selectedItems.filter(i => i !== item.path));
      } else {
        setSelectedItems([...selectedItems, item.path]);
      }
    };
    
    const navigateToFolder = (path) => {
      setCurrentPath(path);
      // Here you would fetch the contents of the new path from MEGA API
      // For now we're just simulating with static data
      if (path === '/Documents') {
        setFiles([
          { id: '10', name: 'Work', type: 'folder', path: '/Documents/Work' },
          { id: '11', name: 'Personal', type: 'folder', path: '/Documents/Personal' },
          { id: '12', name: 'document1.pdf', type: 'file', size: '2.2 MB', path: '/Documents/document1.pdf' },
          { id: '13', name: 'document2.docx', type: 'file', size: '1.1 MB', path: '/Documents/document2.docx' },
        ]);
      } else if (path === '/Images') {
        setFiles([
          { id: '20', name: 'Vacation', type: 'folder', path: '/Images/Vacation' },
          { id: '21', name: 'image1.jpg', type: 'file', size: '3.5 MB', path: '/Images/image1.jpg' },
          { id: '22', name: 'image2.png', type: 'file', size: '2.7 MB', path: '/Images/image2.png' },
        ]);
      } else if (path === '/Videos') {
        setFiles([
          { id: '30', name: 'video1.mp4', type: 'file', size: '25 MB', path: '/Videos/video1.mp4' },
          { id: '31', name: 'video2.mov', type: 'file', size: '40 MB', path: '/Videos/video2.mov' },
        ]);
      } else if (path === '/') {
        setFiles([
          { id: '1', name: 'Documents', type: 'folder', path: '/Documents' },
          { id: '2', name: 'Images', type: 'folder', path: '/Images' },
          { id: '3', name: 'Videos', type: 'folder', path: '/Videos' },
          { id: '4', name: 'file1.jpg', type: 'file', size: '1.5 MB', path: '/file1.jpg' },
          { id: '5', name: 'file2.mp4', type: 'file', size: '15 MB', path: '/file2.mp4' },
        ]);
      }
    };
    
    const handleImport = async () => {
      if (selectedItems.length === 0) {
        toast.error("Please select files or folders to import");
        return;
      }
      
      setIsLoading(true);
      try {
        // Simulation of import - replace with actual MEGA API call
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        setResults({
          success: true,
          imported: selectedItems.length,
          items: selectedItems.map(item => ({ name: item, status: 'Success' }))
        });
        
        toast.success(`${selectedItems.length} items imported successfully`);
      } catch (error) {
        console.error("Import failed:", error);
        toast.error("Import failed: " + (error.message || "Unknown error"));
      } finally {
        setIsLoading(false);
      }
    };
    
    // Load initial files when component mounts
    React.useEffect(() => {
      // This would typically be a call to the MEGA API
      // For now, we're using static mock data
      setFiles([
        { id: '1', name: 'Documents', type: 'folder', path: '/Documents' },
        { id: '2', name: 'Images', type: 'folder', path: '/Images' },
        { id: '3', name: 'Videos', type: 'folder', path: '/Videos' },
        { id: '4', name: 'file1.jpg', type: 'file', size: '1.5 MB', path: '/file1.jpg' },
        { id: '5', name: 'file2.mp4', type: 'file', size: '15 MB', path: '/file2.mp4' },
      ]);
    }, []);
    
    return React.createElement(
      "div",
      { className: "mega-browser-page" },
      React.createElement(
        "div",
        { className: "mega-browser-header" },
        React.createElement(
          "div",
          { className: "title-with-logo" },
          React.createElement("span", {
            dangerouslySetInnerHTML: { __html: megaLogoSVGLarge },
            className: "mega-logo-header"
          }),
          React.createElement("h2", null, "MEGA Cloud Browser")
        ),
        React.createElement(
          "div",
          { className: "mega-browser-actions" },
          React.createElement(
            Button,
            { 
              variant: "secondary", 
              onClick: navigateToStash,
              className: "mr-2"
            },
            [
              React.createElement(Icon, { icon: faHome }),
              " Back to Stash"
            ]
          ),
          React.createElement(
            Button,
            { 
              variant: "primary", 
              onClick: handleImport,
              disabled: isLoading || selectedItems.length === 0,
              className: "mr-2"
            },
            isLoading ? [
              React.createElement(Icon, { icon: faSpinner, spin: true }),
              " Importing..."
            ] : [
              React.createElement(Icon, { icon: faCloudDownloadAlt }),
              " Import Selected"
            ]
          )
        )
      ),
      React.createElement(
        "div",
        { className: "path-navigation mb-3" },
        React.createElement("strong", null, "Current path: "),
        React.createElement("span", null, currentPath)
      ),
      React.createElement(
        "div",
        { className: "mega-browser-content" },
        React.createElement(
          "div",
          { className: "files-container" },
          currentPath !== '/' && React.createElement(
            "div",
            { 
              className: "file-item", 
              onClick: () => navigateToFolder(currentPath.substring(0, currentPath.lastIndexOf('/')) || '/')
            },
            React.createElement(Icon, { icon: faFolder }),
            React.createElement("span", null, "..")
          ),
          files.map(file => React.createElement(
            "div",
            { 
              key: file.id,
              className: `file-item ${selectedItems.includes(file.path) ? 'selected' : ''}`,
              onClick: () => file.type === 'folder' ? navigateToFolder(file.path) : toggleItemSelection(file)
            },
            React.createElement(Icon, { icon: file.type === 'folder' ? faFolder : faFile }),
            React.createElement("span", { className: "file-name" }, file.name),
            file.type === 'file' && React.createElement("span", { className: "file-size" }, file.size),
            file.type === 'file' && React.createElement(
              Form.Check,
              {
                type: "checkbox",
                checked: selectedItems.includes(file.path),
                onChange: (e) => {
                  e.stopPropagation();
                  toggleItemSelection(file);
                },
                onClick: (e) => e.stopPropagation()
              }
            )
          ))
        ),
        selectedItems.length > 0 && React.createElement(
          "div",
          { className: "selection-info mt-3" },
          React.createElement("span", null, `${selectedItems.length} items selected`)
        ),
        results && React.createElement(
          "div",
          { className: "import-results mt-4" },
          React.createElement("h4", null, "Import Results"),
          React.createElement(
            "div",
            { className: "result-summary mb-2" },
            React.createElement("p", null, `Successfully imported ${results.imported} items.`)
          ),
          React.createElement(
            "div",
            { className: "result-details" },
            React.createElement("pre", null, JSON.stringify(results.items, null, 2))
          )
        )
      )
    );
  };

  // Register route for the MEGA browser page
  api.register.route({
    path: '/mega-browser',
    component: MegaBrowserPage
  });

  // Add to navbar using patch.before
  api.patch.before("MainNavBar.UtilityItems", function (props) {
    return [
      {
        children: React.createElement(
          React.Fragment,
          null,
          props.children,
          React.createElement(MegaImportComponent, null)
        ),
      },
    ];
  });

  // Log successful loading
  console.log("MEGA Import plugin loaded successfully");
})(); 