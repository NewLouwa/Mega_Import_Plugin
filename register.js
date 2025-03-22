const { PluginApi } = require('stash-plugin');

// Register the plugin route
PluginApi.register.route({
  path: '/mega-import',
  component: MegaImport,
});

// Add button to navigation
PluginApi.register.component({
  id: 'mega-import-button',
  component: () => (
    <Button 
      variant="primary"
      onClick={() => window.location.href = '/mega-import'}
    >
      <img 
        src="/plugin/mega_import/assets/Mega_logo.svg" 
        alt="MEGA" 
        className="mega-logo"
      />
      Import from MEGA
    </Button>
  ),
  target: 'navbar',
}); 