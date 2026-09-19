/**
 * Type declarations for things the bundler handles but TypeScript does not know
 * about on its own.
 */

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.css";
