/**
 * Helper to trigger PingOne authentication flow
 * Since the MCP server doesn't auto-prompt, we need to initiate login manually
 */

export async function triggerPingOneLogin(
  sessionWorkDir: string,
  mcpServerCommand: string
): Promise<{ success: boolean; message: string }> {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    console.log(`[AUTH] Triggering login command in ${sessionWorkDir}`);
    
    // Run the login command in the session's working directory
    const loginProcess = spawn(mcpServerCommand, ['login'], {
      cwd: sessionWorkDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });
    
    let output = '';
    let errorOutput = '';
    
    loginProcess.stdout.on('data', (data) => {
      output += data.toString();
      console.log(`[AUTH LOGIN] ${data.toString().trim()}`);
    });
    
    loginProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.log(`[AUTH LOGIN STDERR] ${data.toString().trim()}`);
    });
    
    loginProcess.on('close', (code) => {
      if (code === 0) {
        resolve({
          success: true,
          message: 'Login initiated. Please complete the OAuth flow in your browser.'
        });
      } else {
        resolve({
          success: false,
          message: `Login failed: ${errorOutput || output}`
        });
      }
    });
    
    // Timeout after 5 minutes
    setTimeout(() => {
      loginProcess.kill();
      resolve({
        success: false,
        message: 'Login timeout - please try again'
      });
    }, 5 * 60 * 1000);
  });
}
