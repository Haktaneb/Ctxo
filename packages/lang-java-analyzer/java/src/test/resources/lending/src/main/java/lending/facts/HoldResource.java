package lending.facts;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@Path("/holds")
public class HoldResource {
  @GET
  @Path("{id}")
  public String get(long id) {
    return "hold";
  }
}
