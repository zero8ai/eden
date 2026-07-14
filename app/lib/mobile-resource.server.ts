type Action<TArgs> = (args: TArgs) => unknown;

/** Convert web-navigation redirects from shared actions into a native-navigation instruction. */
export const nativeAction =
  <TArgs>(action: Action<TArgs>) =>
  async (args: TArgs) => {
    try {
      const result = await action(args);
      if (
        result instanceof Response &&
        result.status >= 300 &&
        result.status < 400
      ) {
        return Response.json({
          ok: true,
          redirectTo: result.headers.get("Location"),
        });
      }
      return result;
    } catch (error) {
      if (
        error instanceof Response &&
        error.status >= 300 &&
        error.status < 400
      ) {
        return Response.json({
          ok: true,
          redirectTo: error.headers.get("Location"),
        });
      }
      throw error;
    }
  };
