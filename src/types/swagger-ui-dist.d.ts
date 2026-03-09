declare module 'swagger-ui-dist' {
  export function getAbsoluteFSPath(): string;

  const swaggerUiDist: {
    getAbsoluteFSPath: typeof getAbsoluteFSPath;
  };

  export default swaggerUiDist;
}
