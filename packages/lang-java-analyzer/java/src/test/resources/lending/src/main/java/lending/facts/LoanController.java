package lending.facts;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/loans")
public class LoanController {
  @GetMapping("/{id}")
  public String get(long id) {
    return "loan";
  }

  @PostMapping
  public String borrow() {
    return "borrowed";
  }

  @RequestMapping(value = "/renew", method = RequestMethod.POST)
  public String renew() {
    return "renewed";
  }
}
